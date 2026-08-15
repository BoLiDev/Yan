import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
 * Seconds since the beacon was written, or `undefined` when there is no
 * readable one. A beacon stamped in the future reads as 0, never negative.
 */
export function beaconAge(file: string, now: number): number | undefined {
  const beacon = readBeacon(file);
  if (beacon === undefined) return undefined;
  const seconds = Math.floor(now / 1000) - beacon.at;
  return seconds < 0 ? 0 : seconds;
}
