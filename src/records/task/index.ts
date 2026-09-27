/**
 * `tasks/<id>/task.json`, behind one handle. A unit's `history[]` is
 * append-only, and its current branch, target and mr are fields of their own
 * rather than the last history entry — a unit has them before it has any
 * history.
 *
 * Beside it, `tasks/<id>/deliverable.json`: what the task has to build.
 */

export { Task, briefText } from './task.js';
export type { TaskData, UnitData } from './types.js';
export { Deliverables, readDeliverables } from './deliverables.js';
export type { Deliverable } from './deliverables.js';
