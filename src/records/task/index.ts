/**
 * `tasks/<id>/task.json` and `problem.md`, behind one handle: a task's
 * identity, its state, the repositories its trees come from, its
 * deliverables and the resources it refers to; and artifacts/uat/uat.json,
 * what each deliverable is checked by.
 */

export { Task, isResourceKind } from './task.js';
export type { Reordered } from './task.js';
export { Uat, UAT_SIDES, parseUat } from './uat.js';
export type { Renumbered, UatData, UatFile, UatSide } from './uat.js';
export { BRANCH_MARKS, RESOURCE_KINDS, TASK_STATES, branchMark, isClosed } from './types.js';
export type { BranchMark, Deliverable, ResourceKind, TaskData, TaskRepo, TaskState } from './types.js';
