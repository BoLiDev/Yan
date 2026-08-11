/**
 * The shape of `tasks/<id>/task.json`.
 *
 * `TaskData` / `UnitData` are the DOCUMENT — what a read returns. `Task` and
 * `Unit` are the classes that mediate it. Keeping the two named apart matters
 * here: a caller holding a `UnitData` is holding a snapshot that stopped being
 * true the moment anyone wrote; a caller holding a `Unit` is holding a way to
 * ask again.
 */

export const MODES = ['scout', 'branch', 'mr'] as const;
export type Mode = (typeof MODES)[number];

export const ENDS = ['delivered', 'abandoned'] as const;
export type HistoryEnd = (typeof ENDS)[number];

/** Exactly the five fields of branching.md §6.4; `mr` only when there was one. */
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
