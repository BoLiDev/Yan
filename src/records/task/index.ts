/**
 * `tasks/<id>/task.json` and `brief.md`, behind one handle: a task's identity,
 * its state, the repository its tree comes from, and its deliverables.
 */

export { Task } from './task.js';
export { TASK_STATES } from './types.js';
export type { Deliverable, TaskData, TaskRepo, TaskState } from './types.js';
