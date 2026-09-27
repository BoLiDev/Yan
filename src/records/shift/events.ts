import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { YanError } from '../../util/error.js';
import { isoSecond } from '../../util/time.js';

/**
 * What a shift reported, in two files under its `run/`: `run/status`, the
 * permanent log of every event, and `run/undelivered`, the queue of reports
 * that never reached yan.
 */

// --- the permanent log: run/status ----------------------------------------

/**
 * `run/status` is an append-only log of `<ts>\t<state>\t<note>` lines, one per
 * event. The newest line is the last event the shift reported, not its state:
 * a shift that reported `working` an hour ago may be dead now, so what is
 * true about it right now is `yan state`'s to answer, not the log's.
 */

function statusFile(run: string): string {
  return join(run, 'status');
}

/** How many events have been reported. Unreadable or absent log counts as 0. */
export function countEvents(run: string): number {
  const file = statusFile(run);
  if (!existsSync(file)) return 0;
  try {
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l !== '').length;
  } catch {
    return 0;
  }
}

/** One `run/status` line. */
export interface ShiftEvent {
  /** ISO 8601 UTC to the second, as it was written. */
  readonly at: string;
  readonly state: string;
  readonly note: string;
}

/** The newest line of the log; `undefined` when there is none or it cannot be read. */
export function lastEvent(run: string): ShiftEvent | undefined {
  let text: string;
  try {
    text = readFileSync(statusFile(run), 'utf8');
  } catch {
    return undefined;
  }
  const line = text.split(/\r?\n/).filter((l) => l !== '').pop();
  if (line === undefined) return undefined;
  const [at = '', state = '', ...note] = line.split('\t');
  return { at, state, note: note.join('\t') };
}

/**
 * The last URL appearing in any event note, which is the merge request a shift
 * reported. An address only — whether it merged comes from the forge.
 */
export function reportedMr(run: string): string | undefined {
  const file = statusFile(run);
  if (!existsSync(file)) return undefined;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  const urls = text.match(/https?:\/\/\S+/g);
  return urls === null ? undefined : urls[urls.length - 1];
}

/**
 * Append one event. Safe against concurrent writers: the line lands in a
 * single append. Throws if `state` is empty or either argument contains a
 * newline.
 *
 * This is the persistent half of a report and the whole of what is kept.
 * Telling yan is `yan report`'s own job, and it types the note into yan's
 * pane rather than leaving a marker for something to notice.
 */
export function appendEvent(run: string, state: string, note = ''): void {
  if (!state) throw YanError.usage('shift_usage', 'an event needs a state');
  if (`${state}${note}`.includes('\n')) {
    throw YanError.usage('shift_usage', 'an event is one line - a newline would forge a second event');
  }
  mkdirSync(run, { recursive: true });

  appendFileSync(statusFile(run), `${isoSecond()}\t${state}\t${note}\n`);
}

// --- the queue: run/undelivered -------------------------------------------

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
