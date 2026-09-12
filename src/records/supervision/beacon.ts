import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readStamp, stampNumber } from '../../util/stamp.js';

/**
 * `tasks/<id>/run/beacon` holds one line, `<epoch> <pid> <task> <state>`,
 * rewritten by `yan wait` on each turn of its loop. It says the watcher is
 * still going round, which its lock cannot: a process that stopped looping
 * still holds one.
 */

/** What the watcher was doing on its last turn of the loop. */
export type WatcherState = 'subscribed' | 'reconnecting' | 'polling';

export interface Beacon {
  readonly at: number;
  readonly pid: number;
  readonly task: string;
  /** Absent when the line carries three fields, or an unrecognised state. */
  readonly state?: WatcherState;
}

const STATES: readonly string[] = ['subscribed', 'reconnecting', 'polling'];

export function writeBeacon(file: string, task: string, state: WatcherState, now: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${Math.floor(now / 1000)} ${process.pid} ${task} ${state}\n`);
}

export function readBeacon(file: string): Beacon | undefined {
  const fields = readStamp(file);
  if (fields === undefined) return undefined;
  const at = stampNumber(fields, 0);
  const pid = stampNumber(fields, 1);
  if (at === undefined || pid === undefined) return undefined;
  const state = fields[3];
  return {
    at,
    pid,
    task: fields[2] ?? '',
    ...(state !== undefined && STATES.includes(state) ? { state: state as WatcherState } : {}),
  };
}

/**
 * Seconds since the beacon was written, or `undefined` when there is no
 * readable one. A beacon stamped in the future reads as 0, never negative.
 */
export function beaconAge(file: string, now: number): number | undefined {
  const beacon = readBeacon(file);
  if (beacon === undefined) return undefined;
  const seconds = Math.floor(now / 1000) - beacon.at;
  return seconds < 0 ? 0 : seconds;
}
