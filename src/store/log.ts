import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { YanError, usageError } from '../util/error.js';
import { yanHome } from '../util/home.js';
import { normalizePath } from '../util/paths.js';

/**
 * Append one line to `tasks/<id>/log.md`. The TypeScript half of
 * `bin/lib-log.sh` (architecture.md §4.2).
 *
 * This module is deliberately tiny, and that is the point. It is not hiding
 * complexity; it exists so that ONE invariant has exactly one enforcement
 * point:
 *
 *   log.md is APPEND-ONLY. An existing line is never rewritten and never
 *   removed.
 *
 * The API is the enforcement. There is no logSet, no logReplace, no logDelete,
 * no line index anywhere in this file — the only write operation is an append.
 * A caller cannot rewrite a line through this module because no such function
 * exists to call.
 *
 * Because it only ever appends, log.md never produces a merge conflict
 * (memory.md §4.2): two writers add different last lines and git takes both,
 * whereas a rewritten line is exactly what a conflict is made of. That property
 * is the reason the narrative layer is a log and not a document.
 *
 * Shape of one entry:
 *
 *   # t042 unify the auth header
 *
 *   - 08-04  s1 auth       parse the header   → !31 merged into the integration branch
 *
 * One line per event. The date is MM-DD; the year is not carried because the
 * task directory's own lifetime already bounds it and the line has to stay
 * short enough that nobody skips writing it.
 */

export const LOG_USAGE = 'log_usage';
export const LOG_FAILED = 'log_failed';

export function logFile(id: string): string {
  if (!id) throw usageError(LOG_USAGE, 'a task id is required');
  return normalizePath(join(yanHome(), 'tasks', id, 'log.md'));
}

/**
 * Creates log.md with its `# <id> <title>` heading when it is absent. An
 * existing file is never touched — not even its heading — because rewriting the
 * first line is still rewriting a line.
 */
export function logInit(id: string, title = ''): void {
  const file = logFile(id);
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, title === '' ? `# ${id}\n\n` : `# ${id} ${title}\n\n`);
}

function today(): string {
  const now = new Date();
  const mm = `${now.getMonth() + 1}`.padStart(2, '0');
  const dd = `${now.getDate()}`.padStart(2, '0');
  return `${mm}-${dd}`;
}

/**
 * The only write in this module. `when` defaults to today as MM-DD and is
 * accepted only so tests and back-fills are deterministic; it can never point
 * at an existing line.
 */
export function logAppend(id: string, text: string, when = ''): void {
  if (!id || !text) throw usageError(LOG_USAGE, 'usage: logAppend(id, text, [MM-DD])');
  if (text.includes('\n')) {
    throw usageError(LOG_USAGE, 'a log entry is one line - write several entries instead');
  }
  const file = logFile(id);
  logInit(id);
  try {
    appendFileSync(file, `- ${when === '' ? today() : when}  ${text}\n`);
  } catch (cause) {
    throw new YanError(LOG_FAILED, `cannot append to ${file}`, { cause });
  }
}
