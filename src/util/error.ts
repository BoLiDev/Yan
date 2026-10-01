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
    this.exitCode = options?.exitCode ?? 1;
  }

  /**
   * You called this wrongly. Always exit 2, and the only way to say it: 1, the
   * default, means "yan tried, and refused or failed".
   *
   * A broken configuration counts as calling it wrongly when a person wrote
   * the file by hand: the vault's `config.json` is exit 2, because the fix is
   * to edit what you wrote. A file yan writes itself — `vault.json`,
   * `~/.yan/config.json`, `task.json` — being corrupt or out of step is exit
   * 1: nobody called anything wrongly.
   */
  public static usage(code: string, message: string): YanError {
    return new YanError(code, message, { exitCode: 2 });
  }
}

interface YanErrorOptions {
  readonly cause?: unknown;
  readonly exitCode?: number;
}

export function isYanError(value: unknown): value is YanError {
  return value instanceof YanError;
}
