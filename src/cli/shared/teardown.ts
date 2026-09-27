import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { display } from './display.js';
import { repoDir, repoDirIfKnown } from './repo.js';
import { Terminal } from '../../externals/herdr/index.js';
import { WorktreePool, type LeaseRow, type ReturnOptions } from '../../externals/worktree/index.js';
import { Shift } from '../../records/shift/index.js';
import { Task } from '../../records/task/index.js';
import { normalizePath } from '../../util/paths.js';

/**
 * The four steps every teardown repeats — `yan done`, `yan abandon`,
 * `yan shift abandon`, `yan shift done` and a dispatch that fell over before
 * its agent started. Each of them is written to be safe to call on a half-torn
 * shift: an empty pane, a lease nobody holds, a unit whose repo is unknown.
 *
 * Nothing here decides anything. Which of them run, in which order, and what a
 * failure means is the command's, because that is where the answers differ:
 * `yan done` refuses when a tree will not come back, and `yan abandon`
 * reports it and carries on.
 */

/**
 * How a teardown reaches the pool, so a test can pass its own. The two verbs
 * are separate because a caller usually needs only one of them, and a
 * dispatch's `pool` — which also has `get` — must satisfy this too.
 */
export type PoolFor = (clone: string) => Pick<WorktreePool, 'return' | 'status'>;
type Returner = (clone: string) => Pick<WorktreePool, 'return'>;
type Statuser = (clone: string) => Pick<WorktreePool, 'status'>;

/**
 * What a command that tears something down needs from the terminal. `Terminal`
 * is the real one; a test passes its own. `agentAlive` is optional because
 * only `yan shift done` asks — it reports an agent that survived the close
 * rather than assuming it went.
 */
export interface Closer {
  close(pane: string): void;
  clearPaneTitle(pane: string): void;
  agentAlive?(pane: string): 'alive' | 'dead' | 'unknown';
}

/**
 * Close a shift's pane and answer whether its agent really went. Never throws:
 * a pane that cannot be closed is one line on stderr, because the teardown
 * around it has already destroyed things and stopping now would strand them.
 *
 * `true` for a shift with no pane recorded, and for a terminal that cannot say
 * — "still running" is a claim, and only `agentAlive` can make it.
 */
export function closePane(pane: string, terminal?: Closer): boolean {
  if (pane === '') return true;
  const screen = terminal ?? new Terminal();
  display('could not clear the shift pane title', () => {
    screen.clearPaneTitle(pane);
  });
  display('could not close the shift pane', () => {
    screen.close(pane);
  });
  if (screen.agentAlive === undefined) return true;
  try {
    return screen.agentAlive(pane) !== 'alive';
  } catch {
    return true;
  }
}

/** What became of one tree. `path` is where it ended up, or where it still is. */
interface Returned {
  readonly returned: boolean;
  readonly path: string;
  /** Why it did not come back. Absent when it did. */
  readonly reason?: string;
  /** What the pool threw, for a caller that has to keep its exit code. */
  readonly cause?: unknown;
}

/**
 * Give one tree back, identity first. Answers rather than throws, so a
 * teardown returning several reports each of them; the identity is passed
 * through so a slot somebody else now holds is refused rather than wiped.
 */
export function returnLease(
  clone: string,
  tree: string,
  identity: ReturnOptions,
  pool?: Returner,
): Returned {
  try {
    const landed = (pool?.(clone) ?? new WorktreePool(clone)).return(tree, identity);
    return { returned: true, path: landed === '' ? tree : landed };
  } catch (err) {
    return { returned: false, path: tree, reason: err instanceof Error ? err.message : String(err), cause: err };
  }
}

/** A lease of one task, with the clone whose pool is holding it. */
interface Held extends LeaseRow {
  readonly clone: string;
}

/**
 * Every tree the pool is holding for this task, sorted by holder — the answer
 * to "what is still out" when `run/meta.json` is gone and cannot be asked.
 *
 * Looks in every repository the units name and every one a live shift records,
 * since a re-pointed unit can leave a lease task.json no longer mentions. A
 * repository that cannot be resolved is skipped rather than fatal.
 */
export function leasesHeldBy(task: string, pool?: Statuser): Held[] {
  // Two kinds of answer: a unit names its repository as registered, a live
  // shift records the path of the clone it came from.
  const names = new Set<string>();
  try {
    for (const unit of new Task(task).read().units) {
      if (unit.repo !== '') names.add(unit.repo);
    }
  } catch {
    // A task that cannot be read still has shifts whose clones can be.
  }
  const clones = new Set<string>();
  for (const name of names) {
    try {
      clones.add(repoDir('teardown', name));
    } catch {
      // Not registered on this machine; nothing of it can be leased here.
    }
  }
  for (const shift of Shift.liveIn(task)) {
    const clone = shift.meta().clone ?? '';
    if (clone !== '' && existsSync(clone)) clones.add(normalizePath(resolve(clone)));
  }

  const held: Held[] = [];
  for (const clone of clones) {
    let leases: readonly LeaseRow[];
    try {
      leases = (pool?.(clone) ?? new WorktreePool(clone)).status();
    } catch {
      continue;
    }
    for (const lease of leases) {
      if (lease.holder.startsWith(`${task}/`)) held.push({ ...lease, clone });
    }
  }
  return held.sort((a, b) => (a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0));
}

/**
 * The main clone a shift's tree came from, for a `run/meta.json` written
 * before the dispatch recorded one. `''` when nothing on this machine says.
 */
export function cloneOf(task: string, unit: string): string {
  if (task === '' || unit === '' || !Task.exists(task)) return '';
  const repo = new Task(task).findUnit(unit)?.repo ?? '';
  return repo === '' ? '' : (repoDirIfKnown(repo) ?? '');
}
