import { join } from 'node:path';
import { Task } from '../../records/task/index.js';
import { owner } from '../../util/lock.js';

/**
 * The enter lock, and the second fact it carries.
 *
 * `yan continue` takes this lock to answer "is a yan already running on this
 * task", and stamps the pane it was taken in so a refused second `yan continue`
 * can say where the live one is. That pane turns out to answer a different
 * question too: which terminal container this task's work belongs in.
 *
 * So the format lives here rather than in `continue.ts`, for the reason
 * `unitTokens` lives in one place — a writer and a reader in two files disagree
 * eventually, and this one would disagree silently, by placing a shift in a
 * fresh container nobody is looking at.
 *
 * It is a stamp on a lock, not a record. The lock exists to be reclaimed when
 * its holder dies, and the pane goes with it; the caller that wants a container
 * treats `undefined` as "ask something else", never as an error.
 */

/** Where `yan continue` takes the per-task enter lock. */
export function enterLockFile(id: string): string {
  return join(new Task(id).dir, '.enter.lock');
}

/**
 * What the holder writes about itself. `pane` is empty when yan is not running
 * under Herdr at all, which is not a failure and must not produce a `pane=`
 * with nothing after it — `paneOfEnterLock` would then hand back an empty
 * string as though it were an id.
 */
export function enterIdentity(id: string, pane: string): string {
  return `yan ${id}${pane === '' ? '' : ` pane=${pane}`}`;
}

/**
 * The pane the live yan for this task is in, or `undefined`.
 *
 * `undefined` covers every way of not knowing, and they are all ordinary: no
 * yan is running, the yan that is running is not under Herdr, or the lock is
 * there but stale. None of them is worth an error — the caller's next move is
 * to ask somewhere else, not to stop.
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
