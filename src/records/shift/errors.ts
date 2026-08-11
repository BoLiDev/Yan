import { YanError, type YanErrorOptions } from '../../util/error.js';

/** What resolving or reading a shift can fail with. */
const CODES = {
  usage: 'shift_usage',
  missing: 'shift_missing',
  ambiguous: 'shift_ambiguous',
} as const;

export type ShiftErrorKind = keyof typeof CODES;

export class ShiftError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: ShiftErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  /** The caller passed something impossible. Exit 2. */
  public static usage(message: string): ShiftError {
    return new ShiftError('usage', message, { exitCode: 2 });
  }
}
