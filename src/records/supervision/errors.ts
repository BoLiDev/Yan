import { YanError, type YanErrorOptions } from '../../util/error.js';

const CODES = {
  usage: 'supervision_usage',
  unwritable: 'supervision_unwritable',
} as const;

export type SupervisionErrorKind = keyof typeof CODES;

/** What the supervision files can fail with. The predicates never throw. */
export class SupervisionError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: SupervisionErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  public static usage(message: string): SupervisionError {
    return new SupervisionError('usage', message, { exitCode: 2 });
  }
}
