/**
 * `tasks/<id>/task.json`, behind one handle. A unit's `history[]` is
 * append-only, and its current branch, target and mr are fields of their own
 * rather than the last history entry — a unit has them before it has any
 * history.
 */

export { Task, briefText } from './task.js';
export type { AddUnitOptions, HistoryEnd, HistoryEntry, TaskData, UnitData } from './types.js';
