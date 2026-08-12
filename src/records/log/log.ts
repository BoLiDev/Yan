import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { taskDir } from '../../util/vault.js';
import { normalizePath } from '../../util/paths.js';
import { LogError } from './errors.js';

/**
 * One task's `log.md` — the narrative layer (memory.md §4.2).
 *
 * This class is deliberately tiny, and that is the point. It is not hiding
 * complexity; it exists so that ONE invariant has exactly one enforcement
 * point:
 *
 *   log.md is APPEND-ONLY. An existing line is never rewritten and never
 *   removed.
 *
 * The API is the enforcement. There is no set, no replace, no delete, no line
 * index anywhere in this file — the only write is an append. A caller cannot
 * rewrite a line through this class because no such method exists to call.
 *
 * Because it only ever appends, log.md never produces a merge conflict: two
 * writers add different last lines and git takes both, whereas a rewritten line
 * is exactly what a conflict is made of. That property is the reason the
 * narrative layer is a log and not a document.
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
export class Log {
  private readonly id: string;

  /** The file this log is. Public because callers show paths to `user`. */
  public readonly file: string;

  public constructor(taskId: string) {
    if (!taskId) throw LogError.usage('a task id is required');
    this.id = taskId;
    this.file = normalizePath(join(taskDir(taskId), 'log.md'));
  }

  /**
   * Create log.md with its `# <id> <title>` heading when it is absent.
   *
   * An existing file is never touched — not even its heading — because
   * rewriting the first line is still rewriting a line.
   */
  public init(title = ''): void {
    if (existsSync(this.file)) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, title === '' ? `# ${this.id}\n\n` : `# ${this.id} ${title}\n\n`);
  }

  /**
   * The only write. `when` defaults to today as MM-DD and is accepted only so
   * tests and back-fills are deterministic; it can never point at an existing
   * line.
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
