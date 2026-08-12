/**
 * `tasks/<id>/shifts/<sid>/`.
 *
 * The absence that matters: There is no way to read the last status line.
 * Every line in `run/status` is an event, not the current state, and a `last()`
 * would be read as "the state" within a week — so there is `eventCount()` and
 * nothing that hands back a line. `yan state` derives the state from the live
 * sources instead.
 *
 * `Shift.fromEnv()` is how a shift finds itself, which is why `yan report`
 * takes no id: asking a shift to repeat its own is one more thing to get wrong.
 *
 * `run/pulse` is the one thing here nobody reports: a digest of the shift's
 * terminal, sampled from outside, so that a long silence can be told from a
 * stuck one. See `pulse.ts` for why it is a digest and why only `yan wait`
 * takes it.
 */

export { Shift } from './shift.js';
export { ShiftError } from './errors.js';
export { readPulse, writePulse, type Pulse } from './pulse.js';
export type { ShiftMeta } from './types.js';
