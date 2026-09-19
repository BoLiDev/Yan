/**
 * The shape of `tasks/<id>/task.json`. A `TaskData` is one read of the file:
 * `Task.read()` hands it back with a default filled in for anything the file
 * omits or mistypes, and `Task.edit` hands the same shape to a writer.
 */

/**
 * How a round ended.
 *
 *   delivered  the outbound MR merged
 *   abandoned  the MR was closed, or there was work here and it was dropped
 *   unused     nothing ever landed on this branch
 *   unknown    the forge could not be reached, or the round was rotated while
 *              its MR was still open
 */
export const ENDS = ['delivered', 'abandoned', 'unused', 'unknown'] as const;
export type HistoryEnd = (typeof ENDS)[number];

/** One archived round. `mr` is present only when the round opened one. */
export interface HistoryEntry {
  branch: string;
  target: string;
  at: string;
  end: HistoryEnd;
  mr?: string;
}

export interface UnitData {
  name: string;
  repo: string;
  scope: string[];
  needs: string[];
  branch: string;
  target: string;
  mr: string | null;
  history: HistoryEntry[];
}

export interface TaskData {
  version: number;
  id: string;
  title: string;
  complete: boolean;
  /** Given up on rather than finished: also `complete`, since nothing more will happen to it. */
  abandoned: boolean;
  /** When `Task.create` made the task, ISO 8601 UTC to the second; absent on a task older than the field. */
  createdAt?: string;
  /** When the task was marked done or abandoned, the same format; absent while it is open. */
  closedAt?: string;
  units: UnitData[];
}

export interface AddUnitOptions {
  readonly branch?: string;
  readonly scope?: readonly string[];
  readonly needs?: readonly string[];
}
