/**
 * The one error type `yan` throws.
 *
 * plan/conventions.md §2: "Errors carry a code. One `YanError` with a `code`
 * field, thrown by seams after mapping. Never let a Herdr or `gh` error object
 * propagate." The code is what tests assert on; the message is prose and may
 * change without anything breaking.
 */
export class YanError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, options?: { cause?: unknown; exitCode?: number }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'YanError';
    this.code = code;
    // 2 means "you called this wrongly" everywhere in the MVP shell; 1 means
    // "yan tried and refused or failed". Keeping the split is what lets a
    // caller tell a bug from a runtime condition.
    this.exitCode = options?.exitCode ?? 1;
  }
}

export function isYanError(value: unknown): value is YanError {
  return value instanceof YanError;
}

/** A usage error: the caller passed something impossible. Always exit 2. */
export function usageError(code: string, message: string): YanError {
  return new YanError(code, message, { exitCode: 2 });
}
