import { join } from 'node:path';
import { Task } from '../../records/task/index.js';
import { owner } from '../../util/lock.js';

/**
 * The lock `yan continue` takes to answer "is a yan already running on this
 * task", and the identity it stamps on it — which also names the pane that
 * yan is in. The lock is reclaimed when its holder dies, so the pane is only
 * ever known while one is running.
 */

/** Where `yan continue` takes the per-task enter lock. */
export function enterLockFile(id: string): string {
  return join(new Task(id).dir, '.enter.lock');
}

/**
 * What the holder stamps on the lock. An empty `pane` is left off entirely,
 * never written as a bare `pane=`.
 */
export function enterIdentity(id: string, pane: string): string {
  return `yan ${id}${pane === '' ? '' : ` pane=${pane}`}`;
}

/**
 * The pane the live yan for this task is in, or `undefined` for every way of
 * not knowing — no yan running, no Herdr, an unreadable lock. Never throws.
 */
export function paneOfEnterLock(id: string): string | undefined {
  let identity;
  try {
    identity = owner(enterLockFile(id))?.identity;
  } catch {
    return undefined;
  }
  if (identity === undefined) return undefined;
  const pane = /(?:^| )pane=(\S+)/.exec(identity)?.[1];
  return pane === undefined || pane === '' ? undefined : pane;
}
