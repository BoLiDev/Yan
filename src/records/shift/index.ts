/**
 * `tasks/<id>/shifts/<sid>/`.
 *
 * The absence that matters: THERE IS NO WAY TO READ THE LAST STATUS LINE.
 * Every line in `run/status` is an event, not the current state, and a `last()`
 * would be read as "the state" within a week — so there is `eventCount()` and
 * nothing that hands back a line. `yan state` derives the state from the live
 * sources instead.
 *
 * `Shift.fromEnv()` is how a shift finds ITSELF, which is why `yan report`
 * takes no id: asking a shift to repeat its own is one more thing to get wrong.
 */

export { Shift } from './shift.js';
export { ShiftError } from './errors.js';
export type { ShiftMeta } from './types.js';
