import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * `tasks/<id>/run/beacon` — attendance for the WATCHER.
 *
 * PHASE 6 DECIDED TO KEEP THIS, and the reason is worth having in the file
 * rather than only in the design (supervision.md §4).
 *
 * The argument for retiring it was: a subscriber blocked on a socket either
 * holds the connection or it does not, so the guard can ask that directly.
 * That argument assumed one blocking read. What `yan wait` actually is, after
 * the Phase 5 spike, is a loop: a subscription that can end and be reconnected,
 * PLUS a liveness poll, because `pane_exited` cannot be subscribed to
 * (evidence §11.2). "Is the watcher still going round?" is a real question
 * again, and nothing else answers it:
 *
 *   the lock       proves a process exists. A process that has stopped looping
 *                  still holds its lock, and on Windows the subscription is a
 *                  named pipe another process cannot inspect at all
 *   the wake file  proves something HAPPENED, not that anybody is watching
 *
 * WHAT IT ATTESTS TO, AND THIS IS THE CHANGE FROM THE MVP: the beacon is
 * written by the SUPERVISION LOOP, not by the subscription. Every turn of the
 * loop touches it, and the loop keeps turning while a subscription is down and
 * being re-established. So a watcher that is legitimately mid-reconnect is
 * still healthy — it is still looking, and its liveness poll is still the
 * source that never went through the socket in the first place. "Holds a live
 * subscription" would be the wrong test; "went round recently" is the right
 * one, and the price is the freshness window this file has always carried.
 *
 * The line is `<epoch> <pid> <task> <state>`, one line of text, for three
 * reasons that have not changed: reading an mtime portably means `stat` or
 * `find -newermt`, both a second dialect to get wrong; a test can forge a stale
 * beacon without sleeping; and `bin/lib-watch.sh` still reads fields 1 and 2 by
 * position for as long as both halves of the migration are on disk. `state` is
 * the fourth field precisely so that adding it cannot disturb them.
 *
 * The pid is half of the identity check: a beacon left behind by a watcher that
 * is gone must not vouch for a lock somebody else holds, and a lock whose owner
 * never started looping must not be vouched for by an old beacon.
 */

/** What the watcher was doing on its last turn of the loop. Reported, never a verdict. */
export type WatcherState = 'subscribed' | 'reconnecting' | 'polling';

export interface Beacon {
  readonly at: number;
  readonly pid: number;
  readonly task: string;
  /** Absent from a beacon written by the shell half, which has only three fields. */
  readonly state?: WatcherState;
}

const STATES: readonly string[] = ['subscribed', 'reconnecting', 'polling'];

export function writeBeacon(file: string, task: string, state: WatcherState, now: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${Math.floor(now / 1000)} ${process.pid} ${task} ${state}\n`);
}

export function readBeacon(file: string): Beacon | undefined {
  if (!existsSync(file)) return undefined;
  let line: string;
  try {
    line = readFileSync(file, 'utf8').replace(/\r/g, '').split('\n')[0] ?? '';
  } catch {
    return undefined;
  }
  const [at, pid, task, state] = line.split(' ');
  if (at === undefined || !/^\d+$/.test(at)) return undefined;
  if (pid === undefined || !/^\d+$/.test(pid)) return undefined;
  return {
    at: Number(at),
    pid: Number(pid),
    task: task ?? '',
    ...(state !== undefined && STATES.includes(state) ? { state: state as WatcherState } : {}),
  };
}

/**
 * Seconds since the last turn of the loop, or `undefined` when there is no
 * readable beacon.
 *
 * A clock that went backwards reports 0: it is not evidence of staleness, and
 * treating it as such would call a healthy watcher dead over a time sync.
 */
export function beaconAge(file: string, now: number): number | undefined {
  const beacon = readBeacon(file);
  if (beacon === undefined) return undefined;
  const seconds = Math.floor(now / 1000) - beacon.at;
  return seconds < 0 ? 0 : seconds;
}
