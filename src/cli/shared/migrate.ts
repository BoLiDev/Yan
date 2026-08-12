import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { yanHome } from '../../util/home.js';
import { editJson, initJson, readJsonIfPresent, writeJson } from '../../util/json.js';
import { normalizePath } from '../../util/paths.js';
import { out } from './action.js';
import { CommandError } from './errors.js';

/**
 * Not a subcommand, which is why it is under shared/: every top-level file in
 * src/cli/ is a command (util/home.ts derives the list from disk), and this is
 * one command's implementation rather than a command of its own.
 *
 * `yan vault init --from-home` — the one thing that still reads the pre-V3
 * layout, and the last thing that ever will.
 *
 * It is a command rather than a page of instructions for one reason beyond
 * convenience: **it is the test.** V3's whole claim is that the three layers
 * separate cleanly, and moving real tasks, a real registry, a real config and a
 * real clone out of a real home is the only honest way to find out. A checklist
 * proves nothing and cannot be re-run.
 *
 * The order is: preflight everything, copy (never move) the data, move the
 * clones, write both halves of the registry, and leave the old copy alone. The
 * caller deletes it afterwards, by hand or with `--drop-home`, once `yan ls`
 * and `yan doctor` have agreed. Until that moment the migration is additive and
 * undone by deleting one directory.
 */

export interface MigrationPlan {
  readonly home: string;
  readonly vault: string;
  readonly cloneRoot: string;
  readonly tasks: string[];
  readonly repos: { name: string; from: string; to: string }[];
  readonly config: boolean;
  readonly hooks: boolean;
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Something is in the way at a destination.
 *
 * An empty directory is not in the way, and that distinction is not a nicety:
 * the first real run of this migration hit a leftover empty `poe-tools/` beside
 * the mechanics clone and refused, claiming it would merge two clones. There
 * was nothing there to merge.
 */
function occupied(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return !statSync(path).isDirectory() || readdirSync(path).length > 0;
  } catch {
    return true;
  }
}

function entriesOf(file: string): Record<string, Record<string, unknown>> {
  const raw = readJsonIfPresent(file);
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(record)) {
    if (name === 'version') continue;
    if (typeof value === 'object' && value !== null) out[name] = value as Record<string, unknown>;
  }
  return out;
}

/** What is in the old home, and where each part is going. Reads only. */
export function planMigration(vault: string, cloneRoot: string): MigrationPlan {
  const home = yanHome();
  const tasksDir = join(home, 'tasks');
  const tasks = isDir(tasksDir)
    ? readdirSync(tasksDir).filter((id) => existsSync(join(tasksDir, id, 'task.json'))).sort()
    : [];

  const repos: { name: string; from: string; to: string }[] = [];
  for (const name of Object.keys(entriesOf(join(home, 'mem', 'repos.json'))).sort()) {
    const from = join(home, 'repos', name);
    if (!isDir(from)) continue;
    repos.push({ name, from: normalizePath(from), to: normalizePath(join(cloneRoot, name)) });
  }

  return {
    home: normalizePath(home),
    vault: normalizePath(vault),
    cloneRoot: normalizePath(cloneRoot),
    tasks,
    repos,
    config: existsSync(join(home, 'conf', 'config.json')),
    hooks: isDir(join(home, 'conf', 'hooks')),
  };
}

/**
 * Every refusal, before a single file moves.
 *
 * The two that matter are the last two. A live shift means panes and leases
 * that record absolute paths, and moving the task directory under a running
 * agent is how you get a shift writing its outcome into a directory nobody
 * reads again. A lease on a clone that is about to move is worse: the pool's
 * directory is keyed by a hash of that path, so the tree would be orphaned and
 * the work in it unreachable by the pool that made it.
 *
 * The pool is deliberately not rewritten to follow the clone. A tree is a
 * scratch checkout — the pool exists to be thrown away and re-leased — and a
 * migration that rewrites derived state is how you end up with two answers.
 */
export function preflight(plan: MigrationPlan, leasesFor: (clone: string) => number): void {
  const problems: string[] = [];

  for (const repo of plan.repos) {
    if (occupied(repo.to)) {
      problems.push(`${repo.to} already exists - move it aside, or pass --clone-root somewhere else. The migration never merges two clones`);
    }
    let held = 0;
    try {
      held = leasesFor(repo.from);
    } catch {
      held = 0;
    }
    if (held > 0) {
      problems.push(`${repo.name} has ${held} leased tree(s) - 'yan tree return --repo ${repo.name}' first. The pool is keyed by the clone's path, so a lease cannot survive the move`);
    }
  }

  for (const id of plan.tasks) {
    const shifts = join(plan.home, 'tasks', id, 'shifts');
    if (!isDir(shifts)) continue;
    for (const sid of readdirSync(shifts)) {
      if (existsSync(join(shifts, sid, 'run', 'meta.json'))) {
        problems.push(`${id}/${sid} is still live (run/meta.json is there) - clock it out, or 'yan done --force' it, before moving the task directory out from under it`);
      }
    }
  }

  if (problems.length > 0) {
    throw new CommandError('vault', 'preflight', `the migration would not be safe:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
}

/**
 * Copy the data in, move the clones, write both halves.
 *
 * copy, not move, for everything under the old home: until the caller deletes
 * it, the migration can be undone by deleting the vault. The clones are the one
 * exception — two copies of a repository is not a safe state to leave someone
 * in, and the pool has already been proven empty for each of them.
 */
export function migrate(plan: MigrationPlan): void {
  mkdirSync(plan.vault, { recursive: true });

  if (plan.tasks.length > 0) {
    mkdirSync(join(plan.vault, 'tasks'), { recursive: true });
    for (const id of plan.tasks) {
      cpSync(join(plan.home, 'tasks', id), join(plan.vault, 'tasks', id), { recursive: true });
      // run/ is throwaway and machine-local, and the .gitignore in the vault
      // says so; copying it in would commit pane ids on the first push.
      rmSync(join(plan.vault, 'tasks', id, 'run'), { recursive: true, force: true });
      rmSync(join(plan.vault, 'tasks', id, '.enter.lock'), { force: true });
      out(`vault init: task ${id}`);
    }
  }

  const mem = join(plan.home, 'mem');
  if (isDir(mem)) {
    mkdirSync(join(plan.vault, 'mem'), { recursive: true });
    for (const entry of readdirSync(mem)) {
      // The old registry does not travel: it is split below into two files
      // that mean different things.
      if (entry === 'repos.json') continue;
      cpSync(join(mem, entry), join(plan.vault, 'mem', entry), { recursive: true });
    }
  }

  if (plan.config) {
    cpSync(join(plan.home, 'conf', 'config.json'), join(plan.vault, 'config.json'));
    out('vault init: config.json (agents and remote_git follow the context)');
  }
  if (plan.hooks) {
    cpSync(join(plan.home, 'conf', 'hooks'), join(plan.vault, 'hooks'), { recursive: true });
    out('vault init: hooks/');
  }

  const portable = join(plan.vault, 'repos.json');
  const local = join(plan.vault, '.local', 'repos.json');
  mkdirSync(join(plan.vault, '.local'), { recursive: true });
  initJson(portable, { version: 1 });
  initJson(local, { version: 1 });

  const old = entriesOf(join(plan.home, 'mem', 'repos.json'));
  for (const repo of plan.repos) {
    mkdirSync(plan.cloneRoot, { recursive: true });
    // An empty directory at the destination passed preflight; `rename` onto it
    // still fails on Windows, so it goes first.
    rmSync(repo.to, { recursive: true, force: true });
    renameSync(repo.from, repo.to);
    out(`vault init: ${repo.name}  ${repo.from} → ${repo.to}`);

    const entry = old[repo.name] ?? {};
    editJson(portable, (raw) => {
      const reg = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      reg[repo.name] = {
        url: typeof entry.url === 'string' ? entry.url : '',
        mode_default: typeof entry.mode_default === 'string' ? entry.mode_default : 'mr',
        pool_size: typeof entry.pool_size === 'number' ? entry.pool_size : 8,
      };
      return reg;
    });
    editJson(local, (raw) => {
      const reg = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      reg[repo.name] = { path: repo.to };
      return reg;
    });
  }

  // A registry entry with no clone on this disk is a normal state, but one
  // whose clone was never registered at all is a repository yan would forget
  // about entirely, so the entries without directories come across too.
  for (const [name, entry] of Object.entries(old)) {
    if (plan.repos.some((r) => r.name === name)) continue;
    editJson(portable, (raw) => {
      const reg = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      reg[name] = {
        url: typeof entry.url === 'string' ? entry.url : '',
        mode_default: typeof entry.mode_default === 'string' ? entry.mode_default : 'mr',
        pool_size: typeof entry.pool_size === 'number' ? entry.pool_size : 8,
      };
      return reg;
    });
    out(`vault init: ${name} registered, but no clone was under repos/ - 'yan repo link ${name} <path>' when you have one`);
  }
}

/**
 * Everything the old home still holds that the vault does not.
 *
 * The check `dropHome` is not allowed to skip. It compares by task id and by
 * registry entry rather than by byte, because that is the question a person is
 * really asking — did anything get left behind — and a byte comparison would
 * fail on the `run/` directories that are deliberately not copied.
 */
export function stillOnlyInHome(plan: MigrationPlan): string[] {
  const missing: string[] = [];
  for (const id of plan.tasks) {
    if (!existsSync(join(plan.vault, 'tasks', id, 'task.json'))) missing.push(`task ${id}`);
  }
  for (const name of Object.keys(entriesOf(join(plan.home, 'mem', 'repos.json')))) {
    const portable = entriesOf(join(plan.vault, 'repos.json'));
    if (portable[name] === undefined) missing.push(`repository ${name}`);
  }
  for (const entry of isDir(join(plan.home, 'mem')) ? readdirSync(join(plan.home, 'mem')) : []) {
    if (entry === 'repos.json') continue;
    if (!existsSync(join(plan.vault, 'mem', entry))) missing.push(`mem/${entry}`);
  }
  return missing;
}

/** What the old home can give up, once the new one has been checked. */
export function dropHome(plan: MigrationPlan): void {
  for (const rel of ['tasks', 'mem', 'repos', join('conf', 'config.json'), join('conf', 'hooks')]) {
    rmSync(join(plan.home, rel), { recursive: true, force: true });
  }
  writeJson(join(plan.home, '.migrated.json'), {
    version: 1,
    vault: plan.vault,
    note: 'this data lives in the vault above',
  });
  out(`vault init: removed tasks/, mem/, repos/ and conf/config.json from ${plan.home}`);
}
