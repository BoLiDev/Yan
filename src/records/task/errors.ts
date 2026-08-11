import { YanError, type YanErrorOptions } from '../../util/error.js';

/** What reading or writing a task can fail with. */
const CODES = {
  usage: 'task_usage',
  missing: 'task_missing',
  exists: 'task_exists',
} as const;

export type TaskErrorKind = keyof typeof CODES;

export class TaskError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: TaskErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  /** The caller passed something impossible. Exit 2. */
  public static usage(message: string): TaskError {
    return new TaskError('usage', message, { exitCode: 2 });
  }
}
