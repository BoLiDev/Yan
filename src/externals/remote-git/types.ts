/**
 * The vocabulary a caller of this module sees. It never learns whether the
 * repository lives on GitHub or on GitLab.
 *
 * Return values are a closed set defined by yan (delivery.md §8.4). Every path
 * out of `mrState` goes through `gateMrState` and every path out of `ciState`
 * through `gateCiState`, so a fifth value cannot slip in even by accident — and
 * now the compiler says so too (plan/conventions.md §2).
 *
 * The four values of `MrState` exist because branching.md §6.4 needs exactly
 * those four to decide a round's `end`: merged → delivered, closed → abandoned,
 * open → the round is not over, unknown → ask user.
 *
 * CI answers only green or red (plus pending and none) on purpose. "Which job
 * failed" does not line up between the two providers and forcing it to would
 * drop information. What the caller needs is "CI is red". Which job, and why,
 * is the shift's business — and a shift may know which host it is on, because
 * it is reading, not deciding.
 */

export type MrState = 'merged' | 'closed' | 'open' | 'unknown';
export type CiState = 'green' | 'red' | 'pending' | 'none';
export type MergeStrategy = 'merge' | 'squash' | 'rebase';
export type HostKind = 'github' | 'gitlab';

export const MR_STATES: readonly MrState[] = ['merged', 'closed', 'open', 'unknown'];
export const CI_STATES: readonly CiState[] = ['green', 'red', 'pending', 'none'];

/**
 * A repository is named with `repo` (a slug) or `dir` (a path), never with a
 * provider-specific flag.
 */
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

/**
 * The last statement on every path out of the two query verbs. If a mapper or a
 * provider ever produces something else, the gate turns it into the safe member
 * of the set and says so, rather than leaking a fifth value.
 */
export function gateMrState(value: string): MrState {
  if ((MR_STATES as readonly string[]).includes(value)) return value as MrState;
  process.stderr.write(`remote-git: internal: '${value}' is not a merge request state - reporting unknown\n`);
  return 'unknown';
}

/**
 * `pending` is the safe member for CI: it means "no answer yet, ask again".
 * `green` would be dangerous, `red` would send a shift to fix nothing, and
 * `none` would claim this repository has no CI at all.
 */
export function gateCiState(value: string): CiState {
  if ((CI_STATES as readonly string[]).includes(value)) return value as CiState;
  process.stderr.write(`remote-git: internal: '${value}' is not a CI state - reporting pending\n`);
  return 'pending';
}
