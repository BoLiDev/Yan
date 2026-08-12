import type { CliResult } from './client.js';
import type { CiState, MergeStrategy, MrCreateOptions, MrState } from './types.js';

/**
 * What differs between GitHub and GitLab, and nothing else.
 *
 * The five differences between the two hosts — argument shapes, terminology,
 * JSON shapes, authentication, and the CI model itself — all land on this
 * interface. `RemoteGit` implements each verb once against it, so there is no
 * `if (kind === 'github')` anywhere above this line.
 *
 * That is the whole reason the interface exists. In the shell implementation,
 * and in the first TypeScript port, every verb carried its own copy of that
 * branch: four verbs, two providers, eight bodies to keep in step. Adding a
 * third host meant editing four functions and hoping.
 */
export interface Provider {
  readonly cli: 'gh' | 'glab';

  /** Arguments that open a merge request. `body` is already resolved to text. */
  createArgs(options: MrCreateOptions, body: string): string[];

  /**
   * The URL out of a successful create. Each CLI prints prose around it and
   * spells it differently (`/pull/N` vs `/merge_requests/N`), and glab puts it
   * on a different stream, so the provider decides where to look.
   */
  createdUrl(result: CliResult): string;

  /** Arguments that ask for a merge request's state. */
  stateArgs(mr: string, repo: string | undefined): string[];

  /** Arguments that ask for a merge request's CI. */
  ciArgs(mr: string, repo: string | undefined): string[];

  /** Arguments that merge now — never "merge when the pipeline passes". */
  mergeArgs(
    mr: string,
    repo: string | undefined,
    strategy: MergeStrategy,
    deleteSource: boolean,
  ): string[];

  /** Both mappers are pure: no network, no configuration, no module state. */
  mapMrState(payload: string): MrState;
  mapCiState(payload: string): CiState;
}
