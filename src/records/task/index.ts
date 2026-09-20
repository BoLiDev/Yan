/**
 * `tasks/<id>/task.json`, behind one handle. A unit's `history[]` is
 * append-only, and its current branch, target and mr are fields of their own
 * rather than the last history entry — a unit has them before it has any
 * history.
 *
 * Beside it, `tasks/<id>/deliverable.json`: what the task has to build.
 */

export { Task, briefText } from './task.js';
export type { AddUnitOptions, HistoryEnd, HistoryEntry, TaskData, UnitData } from './types.js';
export {
  DELIVERABLE_FILE,
  DELIVERABLE_STATUSES,
  Deliverables,
  deliverableAside,
  isDate,
  readDeliverables,
  refLink,
  shortRef,
  today,
} from './deliverables.js';
export type {
  Abandoned,
  Deliverable,
  DeliverableFile,
  DeliverableStatus,
  DeliverablesRead,
  Done,
  RefLink,
  Todo,
} from './deliverables.js';
