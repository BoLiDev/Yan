import { YanError, type YanErrorOptions } from '../../util/error.js';

/** What the worktree pool can fail with. */
const CODES = {
  usage: 'worktree_usage',
  full: 'worktree_full',
  failed: 'worktree_failed',
  mismatch: 'worktree_mismatch',
} as const;

export type WorktreeErrorKind = keyof typeof CODES;

export class WorktreeError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: WorktreeErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  /** The caller passed something impossible. Exit 2. */
  public static usage(message: string): WorktreeError {
    return new WorktreeError('usage', message, { exitCode: 2 });
  }

  /**
   * The identity check refused a return and nothing was touched. Exit 3, so a
   * retry can tell this from a return that failed.
   */
  public static mismatch(message: string): WorktreeError {
    return new WorktreeError('mismatch', message, { exitCode: 3 });
  }
}
