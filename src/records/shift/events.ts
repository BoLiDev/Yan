import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { YanError } from '../../util/error.js';
import { isoSecond } from '../../util/time.js';

/**
 * What a shift reported, in two files under its `run/`: `run/status`, the
 * permanent log of every event, and `run/undelivered`, the queue of reports
 * that never reached yan. Both are written one event to a line, in the same
 * format:
 *
 *     <ISO 8601 UTC to the second>\t<state>\t<note>
 *
 * The note is the rest of the line, tabs and all.
 */

/** One line of either file. */
export interface ShiftEvent {
  /** ISO 8601 UTC to the second, as it was written. */
  readonly at: string;
  readonly state: string;
  readonly note: string;
}

function eventLine(state: string, note: string, at: Date = new Date()): string {
  return `${isoSecond(at)}\t${state}\t${note}\n`;
}

/** One line, as written; a field the line lacks is empty. */
export function parseEventLine(line: string): ShiftEvent {
  const [at = '', state = '', ...note] = line.split('\t');
  return { at, state, note: note.join('\t') };
}

function lines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l !== '');
}

// --- the permanent log: run/status ----------------------------------------

/**
 * `run/status` is append-only, one line per event. The newest line is the
 * last event the shift reported, not its state: a shift that reported
 * `working` an hour ago may be dead now, so what is true about it right now
 * is `yan state`'s to answer, not the log's.
 */

function statusFile(run: string): string {
  return join(run, 'status');
}

/** How many events have been reported. Unreadable or absent log counts as 0. */
export function countEvents(run: string): number {
  const file = statusFile(run);
  if (!existsSync(file)) return 0;
  try {
    return lines(readFileSync(file, 'utf8')).length;
  } catch {
    return 0;
  }
}

/** The newest line of the log; `undefined` when there is none or it cannot be read. */
export function lastEvent(run: string): ShiftEvent | undefined {
  let text: string;
  try {
    text = readFileSync(statusFile(run), 'utf8');
  } catch {
    return undefined;
  }
  const line = lines(text).pop();
  return line === undefined ? undefined : parseEventLine(line);
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
 *
 * @returns the moment stamped on the line, so a copy of it elsewhere —
 *   `run/undelivered` — can carry the same one.
 */
export function appendEvent(run: string, state: string, note = '', at = new Date()): Date {
  if (!state) throw YanError.usage('shift_usage', 'an event needs a state');
  if (`${state}${note}`.includes('\n')) {
    throw YanError.usage('shift_usage', 'an event is one line - a newline would forge a second event');
  }
  mkdirSync(run, { recursive: true });

  appendFileSync(statusFile(run), eventLine(state, note, at));
  return at;
}

// --- the queue: run/undelivered -------------------------------------------

/**
 * `run/undelivered` holds the reports that reached `run/status` and never
 * reached yan, appended by `yan report` when it cannot type the note into
 * yan's pane: yan was sitting in a dialog, none was running, or Herdr could
 * not be reached.
 *
 * `yan show` and `yan session-start` print the lines, and when they run as the
 * task's own main agent they then remove the file, which is the whole of its
 * life; run from anywhere else they only print. Read first and clear second,
 * so a crash in between repeats a report rather than losing one.
 */

export function undeliveredFile(run: string): string {
  return join(run, 'undelivered');
}

/**
 * Append one report that could not be delivered. Swallows a failed write: the
 * report is already in `run/status`, and a shift blocked here would be a
 * shift stopped by the very yan it was trying to reach.
 */
export function recordUndelivered(run: string, state: string, note: string, now = new Date()): void {
  try {
    mkdirSync(run, { recursive: true });
    appendFileSync(undeliveredFile(run), eventLine(state, note, now));
  } catch {
    // Swallowed: see above.
  }
}

/**
 * A line in the format this file had until 2026-09: `<epoch seconds> <state>
 * <note>`, space separated. The queue is emptied the first time its task's
 * yan reads it, so once every machine has run a yan newer than this, no such
 * line is left, and this can go.
 */
const EPOCH_LINE = /^(\d+) (\S*)(?: (.*))?$/;

/** Every line waiting, oldest first. An absent or unreadable file is none. */
export function readUndelivered(run: string): ShiftEvent[] {
  let text: string;
  try {
    text = readFileSync(undeliveredFile(run), 'utf8');
  } catch {
    return [];
  }
  return lines(text).map((line) => {
    const old = EPOCH_LINE.exec(line);
    if (old === null) return parseEventLine(line);
    const [, epoch = '', state = '', note = ''] = old;
    return { at: isoSecond(new Date(Number(epoch) * 1000)), state, note };
  });
}

/** Forget what has been surfaced. A file that will not go stays. */
export function clearUndelivered(run: string): void {
  try {
    rmSync(undeliveredFile(run), { force: true });
  } catch {
    // The next reader prints it again, which is the harmless way to fail.
  }
}
