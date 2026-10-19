/**
 * `tasks/<id>/task.json` and `problem.md`, behind one handle: a task's
 * identity, its state, the repositories its trees come from, its
 * deliverables and the resources it refers to; and artifacts/uat/uat.json,
 * what each deliverable is checked by.
 */

export { Task, isResourceKind } from './task.js';
export { Uat, UAT_SIDES, parseUat } from './uat.js';
export type { UatData, UatFile, UatSide } from './uat.js';
export { RESOURCE_KINDS, TASK_STATES } from './types.js';
export type { Deliverable, ResourceKind, TaskData, TaskRepo, TaskState } from './types.js';
