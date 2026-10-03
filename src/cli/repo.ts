import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { tildePath } from './shared/style.js';
import { isTty } from './shared/tty.js';
import { link, register, registry, repoNamed, repoWithUrl, reposPath, unregister, type RepoEntry } from '../records/repos/index.js';
import { Task } from '../records/task/index.js';
import { YanError } from '../util/error.js';
import { cloneRepo, remoteUrl } from '../util/git.js';
import { isDirectory, normalizePath, samePath } from '../util/paths.js';
import { repoKey } from '../util/repo-key.js';
import type { RepoRow } from '../ui/prompts.js';

/**
 * `yan repo add | link | ls | rm` — the repositories this context works in,
 * which bare `yan` offers a new task, and where each is cloned on this
 * machine. The only command that writes the registry.
 *
 * `add` reads its argument rather than demanding a URL:
 *
 *   yan repo add                  this clone, or pick from the clones under here
 *   yan repo add ../web           a clone that is already there
 *   yan repo add git@host:org/x   clone it here (or under --path), then register
 *
 * Nothing here clones over a directory that exists or deletes a clone.
 */

/** The repository's own name out of its URL: `org/web.git` is `web`. */
function nameOf(url: string): string {
  return repoKey(url).split('/').pop() ?? url;
}

function isClone(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/** Register the clone at `dir` under `name`, or under its URL's name. */
function addClone(dir: string, name?: string): void {
  const full = normalizePath(resolve(dir));
  const url = remoteUrl(full);
  if (url === undefined) throw YanError.usage('repo_usage', `${full} has no origin - a task's tree is cut from origin, so add one first`);
  const as = register(name !== undefined && name !== '' ? name : nameOf(url), url, full);
  out(`repo add: ${as}  ${tildePath(full)}  ${url}`);
}

/** The clones directly under `dir`, each with what blocks it. One level deep. */
function scan(dir: string): Array<RepoRow & { dir: string }> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    throw YanError.usage('repo_usage', `cannot read ${dir}`);
  }
  const rows: Array<RepoRow & { dir: string }> = [];
  for (const entry of names.sort()) {
    const child = normalizePath(join(dir, entry));
    if (!isDirectory(child) || !isClone(child)) continue;
    const url = remoteUrl(child);
    const known = url === undefined ? undefined : repoWithUrl(url);
    const blocked = url === undefined
      ? 'no origin'
      : known?.clone !== undefined && samePath(known.clone, child) ? 'already registered' : '';
    rows.push({ name: url === undefined ? entry : nameOf(url), hint: url ?? child, blocked, dir: child });
  }
  return rows;
}

async function addHere(dir: string): Promise<void> {
  if (isClone(dir)) {
    addClone(dir);
    return;
  }
  if (!isTty()) throw YanError.usage('repo_usage', 'there is no terminal to pick in: pass a path or a URL');
  const rows = scan(dir);
  if (rows.length === 0) throw YanError.usage('repo_usage', `no git clones directly under ${dir} - the scan is one level deep`);
  const { selectRepos } = await import('../ui/prompts.js');
  const chosen = await selectRepos({
    intro: `yan repo add · ${tildePath(dir)}`,
    message: 'Which of these does this context work in?',
    cancelled: 'nothing was registered',
    rows,
  });
  for (const name of chosen) addClone(rows.find((r) => r.name === name)?.dir as string, name);
  if (chosen.length === 0) out('repo add: nothing picked');
}

function addUrl(url: string, options: AddOptions): void {
  const name = options.name !== undefined && options.name !== '' ? options.name : nameOf(url);
  const root = normalizePath(resolve(options.path ?? process.cwd()));
  const dest = join(root, name);
  if (existsSync(dest)) {
    const existing = remoteUrl(dest);
    if (existing === undefined || repoKey(existing) !== repoKey(url)) {
      throw new YanError('repo_conflict', `${dest} exists and is not a clone of ${url} - move it aside, or pass --path`);
    }
    out(`repo add: ${tildePath(dest)} is already a clone of it, keeping it`);
  } else {
    mkdirSync(root, { recursive: true });
    out(`repo add: cloning ${url} into ${tildePath(dest)} …`);
    const cloned = cloneRepo(root, url, name);
    if (cloned.code !== 0) throw new YanError('repo_clone_failed', `could not clone ${url}: ${cloned.stderr.trim()}`);
  }
  const as = register(name, url, dest);
  out(`repo add: ${as}  ${tildePath(dest)}  ${url}`);
}

/** Does this argument look like a clone URL rather than a path? A bare repository is a clone source too. */
function looksLikeUrl(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^[^/\\]+@[^/\\]+:/.test(target) ||
    (existsSync(join(target, 'HEAD')) && existsSync(join(target, 'objects')));
}

interface AddOptions {
  readonly name?: string;
  readonly path?: string;
}

const add = new Command('add')
  .description('register a repository: this clone, a path, or a URL to clone')
  .argument('[target]', 'a clone URL, a path to a clone, or nothing for the clone here or the clones under here')
  .option('--name <name>', 'register it under this name instead of its URL\'s')
  .option('--path <dir>', 'with a URL: clone into this directory instead of the current one')
  .action(
    action('yan repo add', async (target: string | undefined, options: AddOptions) => {
      if (target === undefined || target === '') {
        await addHere(normalizePath(process.cwd()));
      } else if (looksLikeUrl(target)) {
        addUrl(target, options);
      } else if (isDirectory(target) && isClone(target)) {
        addClone(target, options.name);
      } else {
        throw YanError.usage('repo_usage', `${target} is neither a clone URL nor a clone on this disk`);
      }
    }),
  );

const linkCmd = new Command('link')
  .description('say where a registered repository is cloned on THIS machine')
  .argument('<name>', 'its registered name')
  .argument('<path>', 'the clone')
  .action(
    action('yan repo link', (name: string, path: string) => {
      const entry = registered(name);
      const full = normalizePath(resolve(path));
      const url = isDirectory(full) && isClone(full) ? remoteUrl(full) : undefined;
      if (url === undefined || repoKey(url) !== repoKey(entry.url)) {
        throw YanError.usage('repo_usage', `${full} is not a clone of ${entry.url}`);
      }
      link(entry, full);
      out(`repo link: ${name}  ${tildePath(full)}`);
    }),
  );

const ls = new Command('ls')
  .description('every registered repository, and where it is cloned here')
  .action(
    action('yan repo ls', () => {
      const repos = registry();
      if (repos.length === 0) {
        out(`no repositories are registered in ${tildePath(reposPath())} - 'yan repo add' registers one`);
        return;
      }
      for (const r of repos) {
        const where = r.clone === undefined ? 'not cloned on this machine' : isDirectory(r.clone) ? tildePath(r.clone) : `${tildePath(r.clone)} (gone)`;
        out(`${r.name.padEnd(20)}${where}`);
        out(`${' '.repeat(20)}${r.url}`);
      }
    }),
  );

function registered(name: string): RepoEntry {
  const entry = repoNamed(name);
  if (entry === undefined) throw YanError.usage('repo_usage', `'${name}' is not registered - 'yan repo ls' lists what is`);
  return entry;
}

/** The open tasks working in `entry`, which keep it registered. */
function openTasksIn(entry: RepoEntry): string[] {
  return Task.list().filter((id) => {
    try {
      const data = new Task(id).read();
      return data.state === 'open' && data.repos.some((r) => repoKey(r.url) === repoKey(entry.url));
    } catch {
      return false;
    }
  });
}

function heldBy(entry: RepoEntry): string {
  const holders = openTasksIn(entry);
  return holders.length === 0 ? '' : `open tasks work in it: ${holders.join(', ')}`;
}

function rmOne(name: string): void {
  const entry = registered(name);
  const held = heldBy(entry);
  if (held !== '') throw new YanError('repo_in_use', `'${name}' stays registered - ${held}; 'yan done' them first`);
  unregister(name);
  out(`repo rm: ${name}${entry.clone === undefined ? '' : `  ${tildePath(entry.clone)} is left as it is`}`);
}

const rm = new Command('rm')
  .description('take repositories out of the registry - the clones on disk are left alone')
  .argument('[name]', 'a registered name, or nothing to pick from a list')
  .action(
    action('yan repo rm', async (name: string | undefined) => {
      if (name !== undefined && name !== '') {
        rmOne(name);
        return;
      }
      if (!isTty()) throw YanError.usage('repo_usage', "there is no terminal to pick in: pass the name - 'yan repo ls' lists them");
      const rows = registry().map((r) => ({ name: r.name, hint: r.url, blocked: heldBy(r) }));
      if (rows.length === 0) throw YanError.usage('repo_usage', 'no repositories are registered');
      const { selectRepos } = await import('../ui/prompts.js');
      const chosen = await selectRepos({
        intro: 'yan repo rm',
        message: 'Which of these should this context forget? Clones on disk are left alone.',
        cancelled: 'nothing was removed',
        rows,
      });
      for (const n of chosen) rmOne(n);
      if (chosen.length === 0) out('repo rm: nothing picked');
    }),
  );

export const command = new Command('repo')
  .description('the repositories this context works in, which a new task picks from')
  .addCommand(add)
  .addCommand(linkCmd)
  .addCommand(ls)
  .addCommand(rm);
