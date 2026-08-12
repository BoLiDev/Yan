/**
 * The shape of `tasks/<id>/task.json`.
 *
 * `TaskData` / `UnitData` are the document — what a read returns. `Task` and
 * `Unit` are the classes that mediate it. Keeping the two named apart matters
 * here: a caller holding a `UnitData` is holding a snapshot that stopped being
 * true the moment anyone wrote; a caller holding a `Unit` is holding a way to
 * ask again.
 */

export const MODES = ['scout', 'branch', 'mr'] as const;
export type Mode = (typeof MODES)[number];

/**
 * How a round ended.
 *
 * There are four rather than two because history is append-only: an entry
 * written wrongly can never be corrected, so a rotation must never have to
 * guess how a round ended. `unused` and `unknown` are what keep it from
 * having to — the alternative is refusing to rotate whenever the forge is
 * unreachable, which strands the round instead.
 *
 *   delivered  the outbound MR merged
 *   abandoned  the MR was closed, or there was work here and it was dropped
 *   unused     nothing ever landed on this branch, so there is nothing to
 *              explain - the ordinary case for "I do not want this one"
 *   unknown    the forge could not be reached, or the round was rotated while
 *              its MR was still open. Recorded as such rather than blocked
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
  mode: Mode;
  mr: string | null;
  history: HistoryEntry[];
  [key: string]: unknown;
}

export interface TaskData {
  version: number;
  id: string;
  title: string;
  complete: boolean;
  units: UnitData[];
  [key: string]: unknown;
}

/** The four current scalars, which are fields of the unit and never history. */
export type ScalarField = 'branch' | 'target' | 'mode' | 'mr';

export interface AddUnitOptions {
  readonly branch?: string;
  readonly mode?: string;
  readonly scope?: readonly string[];
  readonly needs?: readonly string[];
}
