import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { taskDir } from '../../util/vault.js';
import { normalizePath } from '../../util/paths.js';
import { LogError } from './errors.js';

/**
 * What a line records. Every line carries exactly one.
 *
 *   agreed     a conclusion, plan or understanding reached with `user`
 *   started    a piece of work began, and what it is for
 *   delivered  a piece of work finished, and what it changed
 *   changed    what happened departs from what the log said before
 *   incident   something went wrong, and how it was resolved
 *   paused     work stopped: where, what is left, what it waits on
 */
export const LOG_TYPES = ['agreed', 'started', 'delivered', 'changed', 'incident', 'paused'] as const;
export type LogType = (typeof LOG_TYPES)[number];

const TYPE_WIDTH = Math.max(...LOG_TYPES.map((t) => t.length));

/** `- MM-DD  <type>  <text>`, capturing the type. */
const TYPED_LINE = new RegExp(`^- \\d{2}-\\d{2} {2}(${LOG_TYPES.join('|')})\\b`);

export function isLogType(value: string): value is LogType {
  return (LOG_TYPES as readonly string[]).includes(value);
}

/**
 * One task's `log.md`, which is append-only: nothing here can rewrite or
 * remove an existing line.
 *
 *   # t042 unify the auth header
 *
 *   - 08-04  started    s1 auth  dispatched on yan/t042-auth-s1 — parse the header
 *   - 08-04  delivered  s1 auth  !31 merged into the integration branch
 */
export class Log {
  private readonly id: string;

  /** Absolute path of the log file, whether or not it exists yet. */
  public readonly file: string;

  public constructor(taskId: string) {
    if (!taskId) throw LogError.usage('a task id is required');
    this.id = taskId;
    this.file = normalizePath(join(taskDir(taskId), 'log.md'));
  }

  /**
   * Create log.md with a `# <id> <title>` heading. An existing file is left
   * exactly as it is, heading included.
   */
  public init(title = ''): void {
    if (existsSync(this.file)) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, title === '' ? `# ${this.id}\n\n` : `# ${this.id} ${title}\n\n`);
  }

  /**
   * Append one line, creating the file if needed.
   *
   * @param when the mm-dd date to stamp; defaults to today.
   * @throws LogError when `type` is not one of LOG_TYPES, or `text` is empty
   *   or contains a newline.
   */
  public append(type: LogType, text: string, when = ''): void {
    if (!isLogType(type)) {
      throw LogError.usage(`'${String(type)}' is not a log type - one of: ${LOG_TYPES.join(' ')}`);
    }
    if (!text || text.trim() === '') throw LogError.usage('usage: append(type, text, [MM-DD])');
    if (text.includes('\n') || text.includes('\r')) {
      throw LogError.usage('a log entry is one line - write several entries instead');
    }
    this.init();
    try {
      appendFileSync(this.file, `- ${when === '' ? today() : when}  ${type.padEnd(TYPE_WIDTH)}  ${text.trim()}\n`);
    } catch (cause) {
      throw new LogError('failed', `cannot append to ${this.file}`, { cause });
    }
  }

  /**
   * The entries worth carrying into a new session: every line whose type is in
   * `keep`, plus the last `tail` entries of any kind, in file order and without
   * repeats. Lines written before entries carried a type can only arrive
   * through the tail. `[]` when there is no log.
   */
  public excerpt(keep: readonly LogType[], tail: number): { lines: string[]; total: number } {
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
      return type !== undefined && (keep as readonly string[]).includes(type);
    });
    return { lines, total: entries.length };
  }
}

function today(): string {
  const now = new Date();
  const mm = `${now.getMonth() + 1}`.padStart(2, '0');
  const dd = `${now.getDate()}`.padStart(2, '0');
  return `${mm}-${dd}`;
}
