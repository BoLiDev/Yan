/**
 * The vocabulary a caller of this module sees; it never learns whether the
 * repository lives on GitHub or on GitLab.
 */

export type MrState = 'merged' | 'closed' | 'open' | 'unknown';
export type MergeStrategy = 'merge' | 'squash' | 'rebase';
export type HostKind = 'github' | 'gitlab';

export const MR_STATES: readonly MrState[] = ['merged', 'closed', 'open', 'unknown'];

/** A repository, named by the path of a clone of it. */
export interface RepoRef {
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
}
