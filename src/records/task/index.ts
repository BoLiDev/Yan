/**
 * `tasks/<id>/task.json`.
 *
 * Three properties of the shape, none of them visible from the signatures:
 *
 *   1. `history[]` is append-only. No method takes a history index, and the
 *      only writer builds `old + [entry]` — so every existing entry survives by
 *      construction rather than by care.
 *   2. The four current scalars are not the last history entry. branch, target,
 *      mode and mr are fields of the unit in their own right. Deriving them
 *      from `history[-1]` looks equivalent and is not: a unit has current
 *      values before it has any history at all.
 *   3. Starting a new round is one operation. `rotate` archives and overwrites
 *      in a single tmp → mv, because a crash between the two would lose the
 *      round it was in.
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
