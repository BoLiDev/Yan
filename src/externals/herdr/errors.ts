import { YanError, type YanErrorOptions } from '../../util/error.js';

/**
 * What the terminal can fail with. Every Herdr error is mapped onto one of
 * these by `cli.ts`, so no Herdr code reaches a caller.
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

  /** herdr refused the command shape, which is a bug in yan. Exit 2. */
  public static bug(message: string): TerminalError {
    return new TerminalError('bug', message, { exitCode: 2 });
  }
}

/**
 * What the event stream can fail with; no Herdr `error.code` reaches a caller.
 * `closed` means reconnect, `unreachable` means there is nothing there to
 * reconnect to.
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
