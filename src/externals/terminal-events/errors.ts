import { YanError, type YanErrorOptions } from '../../util/error.js';

/**
 * What the event stream can fail with.
 *
 * The same closed-set discipline as the terminal's: no Herdr `error.code`
 * escapes this module. A caller branches on `EventsError.codes.refused`, never
 * on `invalid_request` or `unsupported_event_wait_match`.
 *
 * `closed` is the one that carries a design decision. A subscription that ends
 * is NOT a failure of yan and not a reason to stop watching — the Phase 5 spike
 * never got to see a Herdr restart happen under a subscriber (evidence §11.4),
 * so it is treated as a state that arrives rather than one that surprises. It
 * is separate from `unreachable` because the recovery differs: `closed` means
 * reconnect, `unreachable` means there is nothing there to reconnect to.
 */
const CODES = {
  usage: 'events_usage',
  unreachable: 'events_unreachable',
  refused: 'events_refused',
  closed: 'events_closed',
} as const;

export type EventsErrorKind = keyof typeof CODES;

export class EventsError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: EventsErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  /** The caller passed something impossible — a label where a pane id belongs. Exit 2. */
  public static usage(message: string): EventsError {
    return new EventsError('usage', message, { exitCode: 2 });
  }
}
