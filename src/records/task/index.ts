/**
 * `tasks/<id>/task.json` — one of yan's three records (architecture.md §4.2).
 *
 * What this module provides, in full:
 *
 *   new Task(id)
 *     .id .dir .file            where it is
 *     .exists() .read()         the document, read leniently
 *     .title() .isComplete() .setComplete(v)
 *     .containerName()          the terminal container's human name
 *     .units() .unit(name) .findUnit(name)
 *     .addUnit(name, repo, target, options?) → Unit
 *
 *   Task.isId(id) · Task.create(id, title) · Task.list()
 *     The three questions that have no task to ask them of yet.
 *
 *   unit.read() · .set(field, value) · .setScope() · .setNeeds()
 *   unit.rounds() · .appendHistory(…) · .rotate(end, newBranch, at?)
 *
 * What the shape is protecting:
 *
 *   1. `history[]` IS APPEND-ONLY. No method here takes a history index. The
 *      only writer builds `old + [entry]`, so every existing entry survives by
 *      construction rather than by care.
 *   2. THE FOUR CURRENT SCALARS ARE NOT THE LAST HISTORY ENTRY. branch, target,
 *      mode and mr are fields of the unit; "current is history[-1]" is
 *      explicitly rejected by branching.md §6.4.
 *   3. STARTING A NEW ROUND IS ONE OPERATION. `rotate` archives and overwrites
 *      in a single tmp → mv, because a task that crashed between the two would
 *      have lost the round it was in.
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
