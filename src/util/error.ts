/**
 * The base every error yan throws extends — and that nothing throws directly.
 *
 * It is ABSTRACT on purpose. A single concrete `YanError` would mean every
 * failure in the system arrives under one name, and a name that fits everything
 * describes nothing: a caller reading `catch (e: YanError)` learns only that
 * something went wrong somewhere. Each module declares its own subclass in its
 * `errors.ts`, so the throw site says what kind of thing failed
 * (`WorktreeError`, `TerminalError`, `TaskError`) and `code` says which
 * condition.
 *
 * What the base is still for, and why it exists at all:
 *
 *   1. OURS VERSUS THEIRS. `isYanError(e)` is the boundary predicate. A Herdr
 *      or `gh` error object must never propagate (plan/conventions.md §2), so
 *      there has to be one question that separates a condition yan anticipated
 *      from a crash it did not.
 *   2. ONE EXIT MAPPING. `src/cli/shared/action.ts` turns any of these into a
 *      process exit code. Without a shared base that would be one `instanceof`
 *      per module, forever out of date.
 *
 * `code` is the machine-readable half and is what tests assert on; the message
 * is prose and may change without anything breaking. Subclasses prefix their
 * codes with the module name, so `worktree_mismatch` and `term_not_found`
 * cannot be confused even after the class is lost to a JSON boundary.
 */
export abstract class YanError extends Error {
  readonly code: string;
  readonly exitCode: number;

  protected constructor(code: string, message: string, options?: YanErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    // 2 means "you called this wrongly" everywhere in the MVP shell; 1 means
    // "yan tried and refused or failed". Keeping the split is what lets a
    // caller tell a bug from a runtime condition.
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
