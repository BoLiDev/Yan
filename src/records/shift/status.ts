import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { ShiftError } from './errors.js';

/**
 * `run/status` and `run/signal`.
 *
 * Two invariants live here:
 *
 *   1. `run/status` IS APPENDED PLAIN TEXT, never JSON. It has to survive a
 *      crash without damaging what is already there, and a JSON array cannot do
 *      that.
 *
 *   2. EVERY LINE IS AN EVENT, NOT THE CURRENT STATE. There is deliberately NO
 *      function here that reads the last line: a shift that reported `done` an
 *      hour ago and then died has `done` as its last line, and so has one whose
 *      work has since landed. `yan state` derives the state from the live
 *      sources instead. Counting is offered; interpreting the newest line is
 *      not.
 */

export function statusFile(run: string): string {
  return join(run, 'status');
}

export function signalFile(run: string): string {
  return join(run, 'signal');
}

/**
 * How many events have been reported.
 *
 * A count, not a verdict. It tells you whether anything has happened; it says
 * nothing about what the shift is doing now.
 */
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

/**
 * The merge request URL the shift reported, if any.
 *
 * A shift in `mr` mode ends by reporting `done: mr <url>`, so the address
 * reaches yan through the note on a `done` event.
 *
 * Reading a line back does NOT break invariant 2. The verdict — has it merged —
 * still comes from the forge and only from the forge; what is read here is an
 * ADDRESS the shift recorded, which is exactly what an event log is for. The
 * last URL wins, because a shift that reopened its MR reported the newer one
 * later.
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
 * One event, then the wake marker, in that order and in one call.
 *
 * THE ORDER IS NOT ARBITRARY. Signal first would mean a crash in between leaves
 * a marker pointing at nothing: yan wakes, finds no new event, clears the
 * signal — and the event that lands afterwards is then never announced to
 * anyone. Event first means a crash in between leaves a recorded event that
 * nobody was woken for, and supervision's other source catches a shift that
 * crashed mid-report.
 *
 * The line is written by ONE append on purpose. A short single write to a file
 * opened with O_APPEND is not interleaved with another writer's, whereas three
 * writes into the same file are three chances to end up with half a line.
 */
export function appendEvent(run: string, state: string, note = ''): void {
  if (!state) throw ShiftError.usage('an event needs a state');
  if (`${state}${note}`.includes('\n')) {
    throw ShiftError.usage('an event is one line - a newline would forge a second event');
  }
  mkdirSync(run, { recursive: true });

  const ts = `${new Date().toISOString().slice(0, 19)}Z`;
  appendFileSync(statusFile(run), `${ts}\t${state}\t${note}\n`);

  const signal = signalFile(run);
  if (existsSync(signal)) {
    const now = new Date();
    utimesSync(signal, now, now);
  } else {
    closeSync(openSync(signal, 'a'));
  }
}
