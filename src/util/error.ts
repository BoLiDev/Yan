/**
 * The base every error yan throws extends; each module declares its own
 * subclass in its `errors.ts`. `isYanError` separates a condition yan
 * anticipated from a crash it did not, and `src/cli/shared/action.ts` turns
 * any of these into an exit code.
 *
 * `code` is the machine-readable half, prefixed with the module name and safe
 * to assert on; the message is prose and may change.
 */
export abstract class YanError extends Error {
  readonly code: string;
  readonly exitCode: number;

  protected constructor(code: string, message: string, options?: YanErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    // 2 means "you called this wrongly"; 1, the default, means "yan tried, and
    // refused or failed".
    this.exitCode = options?.exitCode ?? 1;
  }
}

export interface YanErrorOptions {
  readonly cause?: unknown;
  readonly exitCode?: number;
}

export function isYanError(value: unknown): value is YanError {
  return value instanceof YanError;
}
