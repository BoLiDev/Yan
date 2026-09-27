import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, relative } from 'node:path';
import { enterIdentity } from '../../src/cli/shared/enter-lock.js';
import { Task } from '../../src/records/task/index.js';
import { fxGit } from './fixtures.js';

/**
 * The records a test sets up by hand, and the ways it reads them back. What a
 * command's own `deps()` look like differs from command to command, so those
 * stay in each file; what is here is the part every file wrote the same way.
 */

export interface Attempt<T> {
  readonly code: number;
  readonly message: string;
  /** What `fn` returned, when it returned. */
  readonly value?: T;
}

/**
 * Call a command's function and report it the way the command layer would: a
 * thrown `YanError` becomes its exit code and message, and a return is code 0.
 */
export function attempt<T>(fn: () => T): Attempt<T> {
  try {
    return { code: 0, message: '', value: fn() };
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { code: e.exitCode ?? 1, message: e.message ?? '' };
  }
}

export interface SnapshotOptions {
  /** Each entry's mtime as well, so a file rewritten with the same bytes shows. */
  readonly mtime?: boolean;
  /** Each file's size as well, so a file rewritten in place shows. */
  readonly size?: boolean;
}

/**
 * Every entry under `dir`, directories included, as sorted paths relative to
 * it: compared before and after a command, it proves the command stored
 * nothing. Symlinks are listed and not followed, which keeps the
 * `node_modules` a `withDist` home links to out of it.
 */
export function snapshot(dir: string, options: SnapshotOptions = {}): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      const st = lstatSync(full);
      let line = relative(dir, full).replace(/\\/g, '/');
      if (options.size === true && st.isFile()) line += ` ${st.size}`;
      if (options.mtime === true) line += ` ${st.mtimeMs}`;
      found.push(line);
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * A live shift, as `yan shift new` leaves one: `run/meta.json` holding
 * `meta`, and `run/status` holding `status` when it is given. Returns the
 * `run/` directory.
 */
export function liveShift(
  home: string,
  task: string,
  sid: string,
  meta: Record<string, unknown> = {},
  status?: string,
): string {
  const run = join(home, 'tasks', task, 'shifts', sid, 'run');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'meta.json'), `${JSON.stringify({ version: 1, ...meta })}\n`);
  if (status !== undefined) writeFileSync(join(run, 'status'), status);
  return run;
}

/** The lock `yan continue` holds, stamped with the pane the main agent is in. */
export function enterLock(home: string, task: string, pane: string): void {
  writeFileSync(
    join(home, 'tasks', task, '.enter.lock'),
    `${JSON.stringify({ pid: process.pid, host: hostname(), at: 0, identity: enterIdentity(task, pane) })}\n`,
  );
}

/** One field of one unit, read straight off `task.json`; `''` when absent. */
export function unitField(home: string, task: string, unit: string, field: string): unknown {
  const doc = JSON.parse(readFileSync(join(home, 'tasks', task, 'task.json'), 'utf8')) as {
    units: Record<string, unknown>[];
  };
  return doc.units.find((u) => u.name === unit)?.[field] ?? '';
}

/** True when `clone` has a local branch of that name. */
export async function hasBranch(clone: string, branch: string): Promise<boolean> {
  return (await fxGit(['-C', clone, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

type AddUnitOptions = NonNullable<Parameters<Task['addUnit']>[3]>;

export interface SeedUnit extends AddUnitOptions {
  readonly repo?: string;
  readonly target?: string;
}

/**
 * The task most tests are about: t042, "unify the auth header", with its one
 * unit `auth` on monorepo-x, targeting master from feat/auth, scoped to
 * apps/auth. `unit` replaces any of those unit fields; `null` leaves the task
 * with no unit at all.
 */
export function seedT042(unit: SeedUnit | null = {}): Task {
  Task.create('t042', 'unify the auth header');
  const task = new Task('t042');
  if (unit === null) return task;
  const { repo = 'monorepo-x', target = 'master', ...rest } = unit;
  task.addUnit('auth', repo, target, { branch: 'feat/auth', scope: ['apps/auth'], ...rest });
  return task;
}
