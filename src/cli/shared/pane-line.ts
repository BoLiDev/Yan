import { YanError } from '../../util/error.js';

/**
 * One line typed into a pane: how long it may be, and what types it. `yan
 * send` types a line into a shift's pane and `yan report` into yan's, and both
 * go down the same `herdr agent prompt` channel, so one limit answers both.
 */

/** The longest line this will send, from `$YAN_SEND_MAX`. */
function sendMax(): number {
  const raw = process.env.YAN_SEND_MAX;
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 1000;
}

/**
 * Hold a line to what one `herdr agent prompt` submission may carry.
 *
 * @throws YanError, carrying `code`, when the line is over it.
 */
export function checkSendLength(line: string, code: string): void {
  const max = sendMax();
  if (line.length > max) {
    throw YanError.usage(code, `that line is ${line.length} characters and the limit is ${max} - write the detail to a file and name its path in the line`,
    );
  }
}

/** What typing a line into a pane needs from the terminal. `Terminal` is the real one. */
export interface LineSender {
  send(pane: string, text: string): void;
}
