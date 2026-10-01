import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { taskDir } from '../../util/vault.js';
import { normalizePath } from '../../util/paths.js';
import { YanError } from '../../util/error.js';
import { localMonthDay } from '../../util/time.js';

/**
 * What a line records. Every line yan writes carries exactly one.
 *
 *   agreed   a conclusion, plan or decision reached with `user`
 *   changed  something departs from what an earlier line said
 *   paused   work stopped: where it stands, what is left, what it waits on
 *
 * A log from before v4 also holds `started`, `delivered` and `incident`
 * lines. They are read like any other line and never written.
 */
export const LOG_TYPES = ['agreed', 'changed', 'paused'] as const;
export type LogType = (typeof LOG_TYPES)[number];

const TYPE_WIDTH = Math.max(...LOG_TYPES.map((t) => t.length));

/** `- MM-DD  <type>  <text>`, capturing the type, whichever word it is. */
const TYPED_LINE = /^- \d{2}-\d{2} {2}([a-z]+)\b/;

export function isLogType(value: string): value is LogType {
  return (LOG_TYPES as readonly string[]).includes(value);
}

/**
 * `tasks/<id>/log.md`: one line per event, appended and never edited. A line
 * that turns out wrong is answered by a later `changed` line.
 */
export class Log {
  /** Absolute path of the log file, whether or not it exists yet. */
  public readonly file: string;

  public constructor(taskId: string) {
    if (!taskId) throw YanError.usage('log_usage', 'a task id is required');
    this.file = normalizePath(join(taskDir(taskId), 'log.md'));
  }

  /**
   * Append one line, creating the file if needed.
   *
   * @param monthDay the date to stamp, `MM-DD`; `''` for today, the local day.
   * @throws YanError when `type` is not one of LOG_TYPES, or `text` is empty
   *   or spans lines.
   */
  public append(type: LogType, text: string, monthDay = ''): void {
    if (!isLogType(type)) {
      throw YanError.usage('log_usage', `'${String(type)}' is not a log type - one of: ${LOG_TYPES.join(' ')}`);
    }
    if (!text || text.trim() === '') throw YanError.usage('log_usage', 'the entry is required - say it in one line');
    if (/[\r\n]/.test(text)) throw YanError.usage('log_usage', 'an entry is one line - write several entries instead');
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `- ${monthDay === '' ? localMonthDay() : monthDay}  ${type.padEnd(TYPE_WIDTH)}  ${text.trim()}\n`);
    } catch (cause) {
      throw new YanError('log_failed', `cannot append to ${this.file}`, { cause });
    }
  }

  /**
   * The lines worth carrying into a new session: every `agreed` and `changed`
   * line, plus the last `tail` lines of any kind, in file order and without
   * repeats. `total` counts every line. Empty when there is no log.
   */
  public recall(tail: number): { lines: string[]; total: number } {
    let text: string;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch {
      return { lines: [], total: 0 };
    }
    const entries = text.split(/\r?\n/).filter((l) => l.startsWith('- '));
    const from = Math.max(0, entries.length - tail);
    const lines = entries.filter((line, i) => {
      if (i >= from) return true;
      const type = TYPED_LINE.exec(line)?.[1];
      return type === 'agreed' || type === 'changed';
    });
    return { lines, total: entries.length };
  }
}
