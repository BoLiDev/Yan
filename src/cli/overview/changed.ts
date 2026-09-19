import { statSync } from 'node:fs';
import { join } from 'node:path';
import { repoDirIfKnown } from '../shared/repo.js';
import { WorktreePool, type LeaseRow } from '../../externals/worktree/index.js';
import type { TaskData, UnitData } from '../../records/task/index.js';
import { git } from '../../util/git.js';
import { later, secondMoment, type Moment } from './when.js';

/**
 * When a task's code last changed. Three answers that must never look alike:
 *
 *   known    looked, and this is the newest change
 *   none     looked, and there is nothing to report: no tree held and no
 *            integration branch with a commit
 *   unknown  could not look: no unit's repository is linked on this machine,
 *            or none of what should be there could be read
 */
export type Changed =
  | { readonly state: 'known'; readonly at: Moment }
  | { readonly state: 'none' }
  | { readonly state: 'unknown' };

/** One unit's answer before it is combined: a moment, `none`, or `unknown`. */
type Found = Moment | 'none' | 'unknown';

/** The pool's leases for one clone; `undefined` when the pool cannot be read. */
export type LeasesOf = (clone: string) => readonly LeaseRow[] | undefined;

export function poolLeases(): LeasesOf {
  const cache = new Map<string, readonly LeaseRow[] | undefined>();
  return (clone) => {
    if (!cache.has(clone)) {
      try {
        cache.set(clone, new WorktreePool(clone).status());
      } catch {
        cache.set(clone, undefined);
      }
    }
    return cache.get(clone);
  };
}

/** Git's answer, or undefined for every way git can fail — including not starting. */
function gitStdout(dir: string, args: readonly string[]): string | undefined {
  try {
    const r = git(dir, args);
    return r.code === 0 ? r.stdout : undefined;
  } catch {
    return undefined;
  }
}

/** The committer time of `ref`, epoch milliseconds. */
function commitTime(dir: string, ref: string): number | undefined {
  const out = gitStdout(dir, ['log', '-1', '--format=%ct', ref, '--']);
  const seconds = Number.parseInt((out ?? '').trim(), 10);
  return Number.isNaN(seconds) ? undefined : seconds * 1000;
}

/**
 * The later of HEAD's commit time and the newest mtime among what
 * `git status --porcelain` lists. `unknown` when the tree is not a working
 * tree git can read.
 */
export function treeChanged(tree: string): Found {
  const status = gitStdout(tree, ['status', '--porcelain=v1', '-z']);
  if (status === undefined) return 'unknown';

  let newest = commitTime(tree, 'HEAD');
  // -z: `XY path\0`, and a rename or copy carries its old path as one more field.
  const fields = status.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code.includes('R') || code.includes('C')) i++;
    try {
      const mtime = statSync(join(tree, path)).mtimeMs;
      if (newest === undefined || mtime > newest) newest = mtime;
    } catch {
      // Deleted: nothing left to date.
    }
  }
  return newest === undefined ? 'none' : secondMoment(newest, 'tree');
}

/** The integration branch's last commit in the clone, local or `origin/`, whichever is later. */
export function branchChanged(clone: string, branch: string): Found {
  if (branch === '') return 'none';
  const times = [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]
    .map((ref) => commitTime(clone, ref))
    .filter((t): t is number => t !== undefined);
  return times.length === 0 ? 'none' : secondMoment(Math.max(...times), 'branch');
}

function combine(found: readonly Found[]): Found {
  if (found.length === 0) return 'none';
  if (found.every((f) => f === 'unknown')) return 'unknown';
  let newest: Moment | undefined;
  for (const f of found) if (typeof f === 'object') newest = later(newest, f);
  return newest ?? 'none';
}

function unitChanged(task: string, unit: UnitData, leasesOf: LeasesOf): Found {
  const clone = repoDirIfKnown(unit.repo);
  if (clone === undefined) return 'unknown';
  const mine = (holder: string): boolean =>
    holder === `${task}/${unit.name}` || holder.startsWith(`${task}/${unit.name}/`);
  const trees = (leasesOf(clone) ?? []).filter((l) => mine(l.holder));
  if (trees.length > 0) return combine(trees.map((t) => treeChanged(t.path)));
  return branchChanged(clone, unit.branch);
}

/**
 * The newest change to a task's code across its units: each tree the task
 * holds (the standing tree and live shifts'), or, for a unit holding none,
 * its integration branch. `unknown` only when no unit could be read at all.
 * Never throws.
 */
export function taskChanged(task: TaskData, leasesOf: LeasesOf = poolLeases()): Changed {
  let found: Found;
  try {
    found = combine(task.units.map((u) => {
      try {
        return unitChanged(task.id, u, leasesOf);
      } catch {
        return 'unknown';
      }
    }));
  } catch {
    found = 'unknown';
  }
  if (found === 'none' || found === 'unknown') return { state: found };
  return { state: 'known', at: found };
}
