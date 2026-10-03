/**
 * `tasks/<id>/task.json` and `problem.md`, behind one handle: a task's
 * identity, its state, the repositories its trees come from, its
 * deliverables and the resources it refers to.
 */

export { Task } from './task.js';
export { TASK_STATES } from './types.js';
export type { Deliverable, TaskData, TaskRepo, TaskState } from './types.js';
