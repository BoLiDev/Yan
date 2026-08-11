/**
 * `tasks/<id>/shifts/<sid>/` — one of yan's three records
 * (architecture.md §4.2).
 *
 * What this module provides, in full:
 *
 *   new Shift(task, sid)
 *     .task .sid .dir .run     where it is
 *     .label()                 how it is named in a message
 *     .isLive()                is `run/` still there
 *     .meta()      → ShiftMeta run/meta.json, read once, every field optional
 *     .eventCount()            how many events, never which
 *     .reportedMr()            the last URL the shift wrote down
 *     .appendEvent(state, note?)
 *
 *   Shift.isId(sid) · Shift.resolve(sid, task?) · Shift.fromDir(dir)
 *   Shift.fromEnv() · Shift.liveIn(task)
 *     The five ways to find one when you do not have it yet. `fromEnv` is how a
 *     shift finds ITSELF: `yan report` takes no id, because asking a shift to
 *     repeat its own is one more thing to get wrong.
 *
 * The absence that matters: THERE IS NO WAY TO READ THE LAST STATUS LINE. Every
 * line in `run/status` is an event, not the current state (agents.md §5.4), and
 * a `last()` would be read as "the state" within a week. `yan state` derives
 * the state from the live sources instead.
 */

export { Shift } from './shift.js';
export { ShiftError } from './errors.js';
export type { ShiftMeta } from './types.js';
