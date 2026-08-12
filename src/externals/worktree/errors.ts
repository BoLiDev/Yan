import { YanError, type YanErrorOptions } from '../../util/error.js';

/**
 * What the worktree pool can fail with.
 *
 * The codes hang off the class rather than living as loose constants, so "what
 * can this module throw" is answered by one thing a reader already has in hand.
 * They keep the `worktree_` prefix because `code` outlives the class: it is what
 * a test asserts on and what survives a JSON boundary.
 */
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

  /** The caller passed something impossible. Exit 2: this is a bug, not a condition. */
  public static usage(message: string): WorktreeError {
    return new WorktreeError('usage', message, { exitCode: 2 });
  }

  /**
   * The identity check refused a return. Nothing was touched.
   *
   * Exit 3 on purpose: an automatic retry has to tell "someone else holds this
   * tree now" apart from "the return failed", and that distinction is the whole
   * point of `--if-lease-id`.
   */
  public static mismatch(message: string): WorktreeError {
    return new WorktreeError('mismatch', message, { exitCode: 3 });
  }
}
