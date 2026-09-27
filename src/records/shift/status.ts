import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { YanError } from '../../util/error.js';

/**
 * `run/status` is an append-only log of `<ts>\t<state>\t<note>` lines, one per
 * event. Nothing here reads the newest line, and callers wanting the shift's
 * current state must ask `yan state` rather than the log.
 */

export function statusFile(run: string): string {
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

  const ts = `${new Date().toISOString().slice(0, 19)}Z`;
  appendFileSync(statusFile(run), `${ts}\t${state}\t${note}\n`);
}
