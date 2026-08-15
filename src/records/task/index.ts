/**
 * `tasks/<id>/task.json`. A unit's `history[]` is append-only, and its current
 * branch, target, mode and mr are fields of their own rather than the last
 * history entry — a unit has them before it has any history.
 */

export { Task } from './task.js';
export { Unit } from './unit.js';
export { TaskError } from './errors.js';
export { MODES, ENDS } from './types.js';
export type {
  AddUnitOptions,
  HistoryEnd,
  HistoryEntry,
  Mode,
  ScalarField,
  TaskData,
  UnitData,
} from './types.js';
