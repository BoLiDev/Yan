import { YanError, type YanErrorOptions } from '../../util/error.js';

const CODES = {
  usage: 'supervision_usage',
  unwritable: 'supervision_unwritable',
} as const;

export type SupervisionErrorKind = keyof typeof CODES;

/**
 * What the supervision files can fail with.
 *
 * Deliberately short. Almost everything this record is asked is a PREDICATE —
 * is the watcher healthy, is this reason already waiting to be drained — and a
 * predicate that throws is a predicate a caller has to wrap. Only two things
 * here are conditions rather than answers: being called wrongly, and not being
 * able to write a file supervision cannot work without.
 */
export class SupervisionError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: SupervisionErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  public static usage(message: string): SupervisionError {
    return new SupervisionError('usage', message, { exitCode: 2 });
  }
}
