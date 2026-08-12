import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * `tasks/<id>/run/beacon` — attendance for the watcher.
 *
 * Why this exists when there is already a lock. The question it answers is "is
 * the watcher still going round", and nothing else in `run/` can answer it:
 *
 *   the lock       proves a process exists. A process that has stopped looping
 *                  still holds its lock, and on Windows the subscription is a
 *                  named pipe another process cannot inspect at all
 *   the wake file  proves something happened, not that anybody is watching
 *
 * That question is real because `yan wait` is a loop rather than one blocking
 * read: a subscription that can end and be reconnected, plus a liveness poll
 * that exists because `pane_exited` cannot be subscribed to at all.
 *
 * It is touched by the loop, not by the subscription, and that distinction is
 * the whole design. A watcher mid-reconnect is still watching — its liveness
 * poll never went through the socket in the first place — so "holds a live
 * subscription" would fail a healthy watcher. "Went round recently" is the
 * right test, and its price is the freshness window.
 *
 * The line is `<epoch> <pid> <task> <state>`, plain text rather than the file's
 * mtime, for two reasons: reading an mtime portably means `stat` or
 * `find -newermt`, a second dialect to get wrong, and a test can forge a stale
 * beacon without sleeping for five minutes.
 *
 * The pid is half of an identity check. A beacon left behind by a watcher that
 * is gone must not vouch for a lock somebody else now holds, and a lock whose
 * owner never started looping must not be vouched for by an old beacon.
 */

/** What the watcher was doing on its last turn of the loop. Reported, never a verdict. */
export type WatcherState = 'subscribed' | 'reconnecting' | 'polling';

export interface Beacon {
  readonly at: number;
  readonly pid: number;
  readonly task: string;
  /** Absent when the line carries only three fields, which is not an error. */
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
