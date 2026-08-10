import { YanError, type YanErrorOptions } from '../../util/error.js';

/** What appending to a task's log can fail with. */
const CODES = {
  usage: 'log_usage',
  failed: 'log_failed',
} as const;

export type LogErrorKind = keyof typeof CODES;

export class LogError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: LogErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  /** The caller passed something impossible. Exit 2. */
  public static usage(message: string): LogError {
    return new LogError('usage', message, { exitCode: 2 });
  }
}
