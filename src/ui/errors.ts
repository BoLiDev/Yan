import { YanError, type YanErrorOptions } from '../util/error.js';

/**
 * What asking a person can fail with: `cancelled` when they pressed escape,
 * from however deep in a wizard, and `blocked` when there was nothing to
 * choose from. Neither is a crash.
 */
const CODES = {
  cancelled: 'ui_cancelled',
  blocked: 'ui_blocked',
} as const;

export type UiErrorKind = keyof typeof CODES;

export class UiError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: UiErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }
}
