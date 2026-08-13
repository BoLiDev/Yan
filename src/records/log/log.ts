import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { taskDir } from '../../util/vault.js';
import { normalizePath } from '../../util/paths.js';
import { LogError } from './errors.js';

/**
 * One task's `log.md`, which is append-only: nothing here can rewrite or
 * remove an existing line.
 *
 *   # t042 unify the auth header
 *
 *   - 08-04  s1 auth       parse the header   → !31 merged into the integration branch
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
   * @throws LogError when `text` is empty or contains a newline.
   */
  public append(text: string, when = ''): void {
    if (!text) throw LogError.usage('usage: append(text, [MM-DD])');
    if (text.includes('\n')) {
      throw LogError.usage('a log entry is one line - write several entries instead');
    }
    this.init();
    try {
      appendFileSync(this.file, `- ${when === '' ? today() : when}  ${text}\n`);
    } catch (cause) {
      throw new LogError('failed', `cannot append to ${this.file}`, { cause });
    }
  }
}

function today(): string {
  const now = new Date();
  const mm = `${now.getMonth() + 1}`.padStart(2, '0');
  const dd = `${now.getDate()}`.padStart(2, '0');
  return `${mm}-${dd}`;
}
