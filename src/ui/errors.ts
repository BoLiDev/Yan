import { YanError, type YanErrorOptions } from '../util/error.js';

/**
 * What asking a person can fail with.
 *
 * Exactly one condition, and it is not really a failure: `user` pressed escape.
 * It is an error rather than a return value because it can happen five prompts
 * deep inside a wizard, and every one of those levels would otherwise have to
 * carry an "or nothing" through its own return type — which is how a cancelled
 * create ends up half-written.
 *
 * `blocked` is the other half: the prompts cannot sensibly run at all, because
 * there is nothing to choose from. Also not a crash, and also something `user`
 * has to be told in one sentence.
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
