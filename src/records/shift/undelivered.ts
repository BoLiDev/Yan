import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `run/undelivered` — the reports that reached `run/status` and never reached
 * yan. One line each, `<epoch> <state> <note>`, appended by `yan report` when
 * it cannot type the note into yan's pane: yan was sitting in a dialog, none
 * was running, or Herdr could not be reached.
 *
 * `yan show` and `yan session-start` print the lines, and when they run as the
 * task's own main agent they then remove the file, which is the whole of its
 * life; run from anywhere else they only print. Read first and clear second,
 * so a crash in between repeats a report rather than losing one.
 */

export interface Undelivered {
  /** Epoch seconds when the report was made. */
  readonly at: number;
  readonly state: string;
  readonly note: string;
}

export function undeliveredFile(run: string): string {
  return join(run, 'undelivered');
}

/** Whether anything is waiting to be surfaced. Never throws. */
export function hasUndelivered(run: string): boolean {
  return existsSync(undeliveredFile(run));
}

/**
 * Append one report that could not be delivered. Swallows a failed write: the
 * report is already in `run/status`, and a shift blocked here would be a
 * shift stopped by the very yan it was trying to reach.
 */
export function recordUndelivered(run: string, state: string, note: string, now = Date.now()): void {
  try {
    mkdirSync(run, { recursive: true });
    const at = Math.floor(now / 1000);
    appendFileSync(undeliveredFile(run), `${at} ${state} ${note}\n`);
  } catch {
    // Swallowed: see above.
  }
}

/** Every line waiting, oldest first. An absent or unreadable file is none. */
export function readUndelivered(run: string): Undelivered[] {
  let text: string;
  try {
    text = readFileSync(undeliveredFile(run), 'utf8');
  } catch {
    return [];
  }
  const rows: Undelivered[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue;
    const [stamp = '', state = '', ...rest] = line.split(' ');
    rows.push({
      at: /^\d+$/.test(stamp) ? Number(stamp) : 0,
      state,
      note: rest.join(' '),
    });
  }
  return rows;
}

/** Forget what has been surfaced. A file that will not go stays. */
export function clearUndelivered(run: string): void {
  try {
    rmSync(undeliveredFile(run), { force: true });
  } catch {
    // The next reader prints it again, which is the harmless way to fail.
  }
}
