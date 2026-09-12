/**
 * The one error yan throws. `isYanError` separates a condition yan
 * anticipated from a crash it did not, and `src/cli/shared/action.ts` turns
 * any of these into an exit code.
 *
 * `code` is the machine-readable half, prefixed with the module or the
 * command that threw — `worktree_full`, `tree_usage` — and the message is
 * prose that may change. Codes are written out at the throw site rather than
 * kept in a table per module: outside the module that throws it, almost
 * nothing reads a code at all.
 */
export class YanError extends Error {
  readonly code: string;
  readonly exitCode: number;

  public constructor(code: string, message: string, options?: YanErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    // 2 means "you called this wrongly"; 1, the default, means "yan tried, and
    // refused or failed".
    this.exitCode = options?.exitCode ?? 1;
  }

  /** You called this wrongly. Always exit 2. */
  public static usage(code: string, message: string): YanError {
    return new YanError(code, message, { exitCode: 2 });
  }
}

export interface YanErrorOptions {
  readonly cause?: unknown;
  readonly exitCode?: number;
}

export function isYanError(value: unknown): value is YanError {
  return value instanceof YanError;
}
