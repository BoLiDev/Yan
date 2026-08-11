import { YanError, type YanErrorOptions } from '../../util/error.js';

const CODES = {
  usage: 'hook_usage',
  refused: 'hook_refused',
  silent: 'hook_silent',
} as const;

export type HookErrorKind = keyof typeof CODES;

/**
 * Something a `conf/hooks/` hook did, or refused to do.
 *
 * `refused` is the one a caller has to catch by name: it means the team's own
 * tooling said no, and the caller must stop rather than fall back to a default
 * (boundaries.md §10). "There is no such hook" is not an error at all and is
 * not in this list — it comes back as `undefined`.
 */
export class HookError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: HookErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  public static usage(message: string): HookError {
    return new HookError('usage', message, { exitCode: 2 });
  }
}
