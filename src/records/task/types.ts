/** The vocabulary of `tasks/<id>/task.json`, version 2. */

export const TASK_STATES = ['open', 'done', 'abandoned'] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface TaskData {
  readonly version: 2;
  readonly id: string;
  readonly title: string;
  readonly state: TaskState;
  /** ISO 8601 UTC to the second. */
  readonly createdAt?: string;
  /** Set when the task is closed, done or abandoned. */
  readonly closedAt?: string;
  /** Why an abandoned task was given up. */
  readonly reason?: string;
  /**
   * The repositories the task works in, one tree each; the first is where its
   * agent starts. Empty for a task with no tree.
   */
  readonly repos: readonly TaskRepo[];
  /** One more than the highest deliverable id ever handed out. */
  readonly nextDeliverable: number;
  /** File order is page order. */
  readonly deliverables: readonly Deliverable[];
  /**
   * What the work refers to, by a name the agent chose: a ticket, a doc, a
   * release, a path. The value is never read as anything in particular.
   * Absent from the file until the first is added.
   */
  readonly resources: Readonly<Record<string, string>>;
}

/** One repository a task works in. */
export interface TaskRepo {
  /**
   * Its remote URL: a URL rather than a path, so it means the same thing on
   * every machine the vault is cloned to.
   */
  readonly url: string;
  /** The packages the task is about, as paths in it. Absent for all of it. */
  readonly scope?: readonly string[];
}

/**
 * One part of the solution: a way the product must be once the task is
 * done, stated so it can be checked, the product as its subject and never
 * the work.
 */
export type Deliverable = Todo | Done | Abandoned;

interface Base {
  /** `d1`, `d2`…: stable inside the task, survives a rewording, never reused. */
  readonly id: string;
  readonly text: string;
}
interface Todo extends Base { readonly status: 'todo' }
interface Done extends Base {
  readonly status: 'done';
  /** Local `YYYY-MM-DD`. */
  readonly doneAt: string;
  /** What proved it, from before v4; read and shown, never written. */
  readonly refs?: readonly string[];
}
interface Abandoned extends Base {
  readonly status: 'abandoned';
  readonly reason: string;
}
