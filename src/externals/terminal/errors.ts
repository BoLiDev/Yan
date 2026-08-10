import { YanError, type YanErrorOptions } from '../../util/error.js';

/**
 * What the terminal can fail with.
 *
 * These four are the closed set every Herdr error is mapped onto (`client.ts`
 * does the mapping). No Herdr code escapes the module: a caller branches on
 * `TerminalError.codes.notFound`, never on `agent_not_found`.
 */
const CODES = {
  usage: 'term_usage',
  unreachable: 'term_unreachable',
  notFound: 'term_not_found',
  refused: 'term_refused',
  bug: 'term_bug',
} as const;

export type TerminalErrorKind = keyof typeof CODES;

export class TerminalError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: TerminalErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  /** The caller passed something impossible — a label where an id belongs. Exit 2. */
  public static usage(message: string): TerminalError {
    return new TerminalError('usage', message, { exitCode: 2 });
  }

  /**
   * herdr answered rc 2: a CLI syntax error, which is a bug in yan and never a
   * runtime condition. Exit 2 for the same reason.
   */
  public static bug(message: string): TerminalError {
    return new TerminalError('bug', message, { exitCode: 2 });
  }
}
