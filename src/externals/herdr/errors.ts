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

/**
 * What the event stream can fail with.
 *
 * The same closed-set discipline as the terminal's: no Herdr `error.code`
 * escapes this module. A caller branches on `EventsError.codes.refused`, never
 * on `invalid_request` or `unsupported_event_wait_match`.
 *
 * `closed` is the one that carries a design decision. A subscription that ends
 * is not a failure of yan and not a reason to stop watching, so it is treated
 * as a state that arrives rather than one that surprises. It
 * is separate from `unreachable` because the recovery differs: `closed` means
 * reconnect, `unreachable` means there is nothing there to reconnect to.
 */
const EVENT_CODES = {
  usage: 'events_usage',
  unreachable: 'events_unreachable',
  refused: 'events_refused',
  closed: 'events_closed',
} as const;

export type EventsErrorKind = keyof typeof EVENT_CODES;

export class EventsError extends YanError {
  public static readonly codes = EVENT_CODES;

  public constructor(kind: EventsErrorKind, message: string, options?: YanErrorOptions) {
    super(EVENT_CODES[kind], message, options);
  }

  /** The caller passed something impossible — a label where a pane id belongs. Exit 2. */
  public static usage(message: string): EventsError {
    return new EventsError('usage', message, { exitCode: 2 });
  }
}
