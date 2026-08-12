import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve as resolvePath } from 'node:path';
import { Command } from 'commander';
import { clone, remoteUrl } from '../util/git.js';
import { editJson, initJson } from '../util/json.js';
import { cloneRoot } from '../util/machine.js';
import { normalizePath, samePath } from '../util/paths.js';
import { localReposPath, reposPath, vaultDir } from '../util/vault.js';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { defaultCloneRoot, isClone, lookup, registry } from './shared/repo.js';
import { isTty } from './shared/resolve.js';

/**
 * `yan repo add | link | ls` — which repositories this context knows about,
 * and where they are on this machine (v3 td repos.md).
 *
 * THIS COMMAND IS THE ONLY WRITER OF THE REGISTRY, both halves. Nothing else
 * may create, edit or delete `repos.json` or `.local/repos.json`: one owner per
 * piece of information (design principle 2).
 *
 * What V3 removed is `$YAN_HOME/repos/<name>/` — a second clone of a repository
 * you already have on disk, costing a full fetch and invisible from your own
 * project directory. Registering is now the normal case and cloning is the
 * exception, which is why `add` reads its argument rather than demanding a URL:
 *
 *   yan repo add                    scan the current directory, multi-select
 *   yan repo add ../poe-tools       register a clone that is already there
 *   yan repo add git@host:org/x     clone into clone_root, then register
 *
 * Two behaviours that outlived the rewrite, because the reasons did:
 *
 *   * Idempotent. Re-adding never clobbers a `mode_default` or `pool_size`
 *     someone has tuned. Only an explicit flag changes them.
 *   * It never clones over an existing directory. "Delete and retry" is not
 *     something a tool should do to a directory it did not create.
 */

const MODE_DEFAULT = 'mr'; // delivery.md §8.2
const POOL_SIZE = 8; // worktree.md §7

/**
 * Handles both spellings a forge hands out:
 *   git@host:org/name.git      ssh://git@host:22/org/name.git
 *   https://host/org/name.git  https://host/org/name/
 */
export function repoNameFromUrl(url: string): string {
  let u = url.replace(/\/+$/, '');
  u = u.replace(/\.git$/, '');
  const lastSlash = u.slice(u.lastIndexOf('/') + 1);
  return lastSlash.slice(lastSlash.lastIndexOf(':') + 1);
}

/**
 * Two URLs naming the same repository.
 *
 * A local path we built and a local path git printed back can differ in
 * spelling on Windows, so those go through `normalizePath` (conventions §3).
 * Remote URLs (`git@…`, `https://…`) have no such problem and are compared
 * verbatim.
 */
export function sameUrl(a: string, b: string): boolean {
  if (a === b) return true;
  const isLocal = (s: string): boolean => /^([/\\]|[A-Za-z]:[\\/])/.test(s);
  if (!isLocal(a) || !isLocal(b)) return false;
  return samePath(a, b);
}

function checkName(name: string): void {
  if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw CommandError.usage('repo', `'${name}' is not a usable repository name - pass --name`);
  }
  if (name === 'version') {
    // The registry keeps repositories at the top level beside `version`, so
    // that one name is not available.
    throw CommandError.usage('repo', "'version' is not a usable repository name - pass --name");
  }
}

/** The portable half. Merged, never replaced. */
function writePortable(name: string, url: string, mode: string, pool: string): void {
  const file = reposPath();
  mkdirSync(vaultDir(), { recursive: true });
  initJson(file, { version: 1 });
  editJson(file, (raw) => {
    const reg = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const before = (typeof reg[name] === 'object' && reg[name] !== null ? reg[name] : {}) as Record<string, unknown>;
    reg[name] = {
      ...before,
      url,
      mode_default: mode !== '' ? mode : (before.mode_default ?? MODE_DEFAULT),
      pool_size: pool !== '' ? Number(pool) : (before.pool_size ?? POOL_SIZE),
    };
    return reg;
  });
}

/** The machine half. Never committed, and the only thing `link` writes. */
function writeLocal(name: string, dir: string): void {
  const file = localReposPath();
  mkdirSync(join(vaultDir(), '.local'), { recursive: true });
  initJson(file, { version: 1 });
  editJson(file, (raw) => {
    const reg = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    reg[name] = { path: normalizePath(dir) };
    return reg;
  });
}

/**
 * A name that is taken by a different repository.
 *
 * Checked BEFORE anything is cloned or written, in every one of the three
 * forms. The failure it prevents is a person typing a name they have used
 * before, waiting out a clone, and then being told it was never going to work.
 */
function checkConflict(name: string, url: string): void {
  const existing = lookup(name);
  if (existing !== undefined && existing.url !== '' && url !== '' && !sameUrl(existing.url, url)) {
    throw new CommandError('repo', 'conflict', `'${name}' is already registered as ${existing.url} - pass --name to register ${url} under a different name`);
  }
}

/** Register one clone that is already on this disk. Both halves. */
function registerClone(name: string, dir: string, url: string, mode = '', pool = ''): void {
  checkName(name);
  checkConflict(name, url);
  writePortable(name, url, mode, pool);
  writeLocal(name, dir);
}

interface AddOptions {
  readonly name?: string;
  readonly modeDefault?: string;
  readonly poolSize?: string;
  readonly path?: string;
}

function checkFlags(options: AddOptions): { mode: string; pool: string } {
  const mode = options.modeDefault ?? '';
  if (mode !== '' && !['scout', 'branch', 'mr'].includes(mode)) {
    throw CommandError.usage('repo', `invalid --mode-default '${mode}' - one of: scout branch mr`);
  }
  const pool = options.poolSize ?? '';
  if (pool !== '' && (!/^[0-9]+$/.test(pool) || Number(pool) <= 0)) {
    throw CommandError.usage('repo', `invalid --pool-size '${pool}' - a positive integer`);
  }
  return { mode, pool };
}

export interface Candidate {
  readonly name: string;
  readonly dir: string;
  readonly url: string;
  /** Why it cannot be selected, or the empty string when it can. */
  readonly blocked: string;
}

/**
 * The children of `dir` that are git clones, and what is wrong with each.
 *
 * ONE LEVEL, NOT RECURSIVE. Recursion means walking into `node_modules` and
 * every vendored checkout to find things nobody wants; `cd` to the right
 * parent first costs nothing.
 *
 * A clone with no `origin` is LISTED AND DISABLED rather than skipped: a
 * repository with no remote cannot be delivered from, and silently leaving it
 * out looks like a bug in the scan.
 */
export function scan(dir: string): Candidate[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw CommandError.usage('repo', `cannot read ${dir}`);
  }

  const found: Candidate[] = [];
  for (const entry of names.sort()) {
    const child = join(dir, entry);
    try {
      if (!statSync(child).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!isClone(child)) continue;

    const url = remoteUrl(child) ?? '';
    const name = url === '' ? entry : repoNameFromUrl(url);
    const known = lookup(name);
    let blocked = '';
    if (url === '') {
      blocked = 'no origin - a repository with no remote cannot be delivered from';
    } else if (known?.path !== undefined && samePath(known.path, child)) {
      blocked = 'already registered';
    } else if (known !== undefined && known.url !== '' && !sameUrl(known.url, url)) {
      blocked = `the name '${name}' is taken by ${known.url}`;
    }
    found.push({ name, dir: normalizePath(child), url, blocked });
  }
  return found;
}

async function addByScan(dir: string, options: AddOptions): Promise<void> {
  const { mode, pool } = checkFlags(options);

  // No TTY wins over everything else, and it is checked FIRST — the same
  // ordering `resolve()` uses, and for the same reason: a script, a hook or an
  // agent that reached a prompt would wait forever with nobody to answer it,
  // so the refusal has to be about the missing argument rather than about
  // whatever the scan happened to find.
  if (!isTty()) {
    throw CommandError.usage('repo', `there is no terminal to select in: pass a path or a URL. 'yan repo add' with no argument is the interactive form`);
  }

  const candidates = scan(dir);
  if (candidates.length === 0) {
    throw new CommandError('repo', 'empty', `no git clones directly under ${dir} - the scan is one level deep, so cd to the directory that holds them`);
  }

  const { chooseReposToAdd } = await import('../ui/prompts.js');
  const chosen = await chooseReposToAdd(dir, candidates);
  for (const name of chosen) {
    const candidate = candidates.find((c) => c.name === name);
    if (candidate === undefined) continue;
    registerClone(candidate.name, candidate.dir, candidate.url, mode, pool);
    out(`repo add: ${candidate.name}  ${candidate.dir}`);
  }
  if (chosen.length === 0) out('repo add: nothing selected');
}

function addByPath(dir: string, options: AddOptions): void {
  const { mode, pool } = checkFlags(options);
  const full = normalizePath(resolvePath(dir));
  if (!isClone(full)) {
    throw CommandError.usage('repo', `${full} is not a git clone - there is no .git in it`);
  }
  const url = remoteUrl(full) ?? '';
  if (url === '' && (options.name ?? '') === '') {
    throw CommandError.usage('repo', `${full} has no origin, so its name cannot be derived - pass --name`);
  }
  const name = options.name !== undefined && options.name !== '' ? options.name : repoNameFromUrl(url);
  registerClone(name, full, url, mode, pool);
  out(`repo add: ${name}  ${full}  ${url === '' ? '(no origin)' : url}`);
}

function addByUrl(url: string, options: AddOptions): void {
  const { mode, pool } = checkFlags(options);
  const name = options.name !== undefined && options.name !== '' ? options.name : repoNameFromUrl(url);
  checkName(name);
  checkConflict(name, url);

  const root = normalizePath(resolvePath(options.path ?? cloneRoot() ?? defaultCloneRoot()));
  const dest = join(root, name);

  if (existsSync(dest)) {
    const existing = remoteUrl(dest) ?? '';
    if (!sameUrl(existing, url)) {
      throw new CommandError('repo', 'conflict', `${dest} already exists and is not a clone of ${url} (origin: ${existing === '' ? 'none' : existing}) - move it aside first; repo add never clones over an existing directory`);
    }
    out(`repo add: ${dest} already exists, keeping it (no re-clone)`);
  } else {
    mkdirSync(root, { recursive: true });
    out(`repo add: cloning ${url} into ${dest}`);
    if (clone(root, url, name).code !== 0) {
      throw new CommandError('repo', 'clone_failed', `clone failed: ${url}`);
    }
  }

  registerClone(name, normalizePath(dest), url, mode, pool);
  const after = lookup(name);
  out(`repo add: ${name}  url=${after?.url ?? url}  mode_default=${after?.modeDefault ?? MODE_DEFAULT}  pool_size=${String(after?.poolSize ?? POOL_SIZE)}`);
}

/** A URL, a directory, or nothing — told apart by looking, never by a flag. */
function looksLikeUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^[^/\\]+@[^/\\]+:/.test(target);
}

/**
 * A bare repository on this disk is a CLONE SOURCE, not a clone.
 *
 * `git clone /srv/git/thing.git` is an ordinary thing to do, and the argument
 * is a directory that exists — so without this the path branch would claim it
 * and refuse it for having no `.git`. A bare repo has git's own contents at the
 * top instead.
 */
function isBareRepo(dir: string): boolean {
  return existsSync(join(dir, 'HEAD')) && existsSync(join(dir, 'objects'));
}

const addRepo = new Command('add')
  .description('register a repository: scan this directory, take a path, or clone a URL')
  .argument('[target]', 'a clone URL, a path to a clone, or nothing to scan the current directory')
  .option('--name <name>', 'register under this name instead of one derived from the URL')
  .option('--mode-default <mode>', 'scout | branch | mr')
  .option('--pool-size <n>', 'how many worktrees this repository may lease at once')
  .option('--path <dir>', 'clone into this directory instead of clone_root')
  .action(
    action('repo_add', async (target: string | undefined, options: AddOptions) => {
      if (target === undefined || target === '') {
        await addByScan(process.cwd(), options);
        return;
      }
      if (looksLikeUrl(target) || isBareRepo(target)) {
        addByUrl(target, options);
        return;
      }
      if (existsSync(target)) {
        addByPath(target, options);
        return;
      }
      throw CommandError.usage('repo', `${target} is neither a clone URL nor a directory that exists`);
    }),
  );

const linkRepo = new Command('link')
  .description("say where a registered repository is on THIS machine")
  .argument('[name]')
  .argument('[path]')
  .action(
    action('repo_link', (name: string | undefined, path: string | undefined) => {
      if (name === undefined || name === '' || path === undefined || path === '') {
        throw CommandError.usage('repo', "both a name and a path are required: 'yan repo link <name> <path>'");
      }
      const entry = lookup(name);
      if (entry === undefined) {
        throw new CommandError('repo', 'missing', `'${name}' is not registered in this vault - 'yan repo add' registers it, 'yan repo ls' lists what is there`);
      }
      const full = normalizePath(resolvePath(path));
      if (!isClone(full)) {
        throw CommandError.usage('repo', `${full} is not a git clone - there is no .git in it`);
      }
      writeLocal(name, full);
      out(`repo link: ${name}  ${full}`);
    }),
  );

const lsRepos = new Command('ls')
  .description('what this vault knows about, and what is linked on this machine')
  .action(
    action('repo_ls', () => {
      const repos = registry();
      if (repos.length === 0) {
        out(`no repositories are registered in ${reposPath()}`);
        out("register one with 'yan repo add' where your clones live");
        return;
      }
      let unlinked = 0;
      for (const repo of repos) {
        const where = repo.path ?? 'NOT LINKED on this machine';
        if (repo.path === undefined) unlinked += 1;
        out(`${repo.name.padEnd(20)}${where}`);
        out(`${' '.repeat(20)}${repo.url}  mode=${repo.modeDefault}  pool=${String(repo.poolSize)}`);
      }
      if (unlinked > 0) {
        out('');
        out(`${unlinked} registered but not linked here - 'yan repo add' where your clones live, or 'yan repo link <name> <path>'`);
      }
    }),
  );

export const command = new Command('repo')
  .description('the repositories this context works in')
  .addCommand(addRepo)
  .addCommand(linkRepo)
  .addCommand(lsRepos);

/** Kept for the one caller that still asks: the clone directory's own name. */
export function repoBasename(dir: string): string {
  return basename(normalizePath(dir));
}
