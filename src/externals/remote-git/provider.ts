import type { CliResult } from './client.js';
import type { CiState, MergeStrategy, MrCreateOptions, MrState } from './types.js';

/**
 * What differs between GitHub and GitLab, and nothing else — argument shapes,
 * terminology, JSON shapes and the CI model. `RemoteGit` implements each verb
 * once against this.
 */
export interface Provider {
  readonly cli: 'gh' | 'glab';

  /** Arguments that open a merge request. `body` is already resolved to text. */
  createArgs(options: MrCreateOptions, body: string): string[];

  /**
   * The URL out of a successful create, taken from whichever stream this CLI
   * prints it on.
   *
   * @throws RemoteGitError `failed` when there is no URL to find.
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

  /** Pure: the payload is the CLI's stdout, and nothing else is consulted. */
  mapMrState(payload: string): MrState;
  mapCiState(payload: string): CiState;
}
