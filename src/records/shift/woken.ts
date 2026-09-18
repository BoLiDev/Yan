import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readStamp } from '../../util/stamp.js';

/**
 * `run/woken` holds one word: the status — `blocked` or `done` — the watcher
 * last woke the main agent for. It turns a status that stays put into one wake
 * per entry, and outlives the watcher, which is re-armed every turn. It is the
 * watcher's own channel: nothing else decides anything from it.
 */

export type WokenFor = 'blocked' | 'done';

export function wokenFile(run: string): string {
  return join(run, 'woken');
}

export function readWoken(run: string): WokenFor | undefined {
  const word = readStamp(wokenFile(run))?.[0];
  return word === 'blocked' || word === 'done' ? word : undefined;
}

/** Swallows a failed write: the cost is one repeated wake, not a lost one. */
export function writeWoken(run: string, status: WokenFor): void {
  try {
    mkdirSync(run, { recursive: true });
    writeFileSync(wokenFile(run), `${status}\n`);
  } catch {
    // Swallowed: see above.
  }
}

export function clearWoken(run: string): void {
  try {
    rmSync(wokenFile(run), { force: true });
  } catch {
    // A stamp that will not go stays; the next status change tries again.
  }
}
