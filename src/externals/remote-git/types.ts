/**
 * The vocabulary a caller of this module sees; it never learns whether the
 * repository lives on GitHub or on GitLab.
 */

export type MrState = 'merged' | 'closed' | 'open' | 'unknown';
export type CiState = 'green' | 'red' | 'pending' | 'none';
export type MergeStrategy = 'merge' | 'squash' | 'rebase';
export type HostKind = 'github' | 'gitlab';

export const MR_STATES: readonly MrState[] = ['merged', 'closed', 'open', 'unknown'];
export const CI_STATES: readonly CiState[] = ['green', 'red', 'pending', 'none'];

/** A repository, named either by slug or by the path of a clone of it. */
export interface RepoRef {
  readonly repo?: string;
  readonly dir?: string;
}

export interface MrCreateOptions extends RepoRef {
  readonly source: string;
  readonly target: string;
  readonly title: string;
  readonly body?: string;
  readonly bodyFile?: string;
  readonly draft?: boolean;
}

export interface MrRef extends RepoRef {
  /** The URL `createMr` returned, or a plain number. */
  readonly mr: string;
}

export interface MrMergeOptions extends MrRef {
  readonly strategy?: MergeStrategy;
  readonly deleteSource?: boolean;
}

/** Anything outside the set becomes `unknown`, with a note on stderr. */
export function gateMrState(value: string): MrState {
  if ((MR_STATES as readonly string[]).includes(value)) return value as MrState;
  process.stderr.write(`remote-git: internal: '${value}' is not a merge request state - reporting unknown\n`);
  return 'unknown';
}

/** Anything outside the set becomes `pending`, with a note on stderr. */
export function gateCiState(value: string): CiState {
  if ((CI_STATES as readonly string[]).includes(value)) return value as CiState;
  process.stderr.write(`remote-git: internal: '${value}' is not a CI state - reporting pending\n`);
  return 'pending';
}
