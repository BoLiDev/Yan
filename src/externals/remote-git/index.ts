/**
 * The remote git host: GitHub or GitLab behind four verbs. Return values are a
 * closed set defined by yan, never the host's own words.
 */

export { RemoteGit, configuredCli } from './remote-git.js';
export type { CliRunner, RemoteGitOptions } from './remote-git.js';
export { CI_STATES, MR_STATES } from './types.js';
export type {
  CiState,
  HostKind,
  MergeStrategy,
  MrCreateOptions,
  MrMergeOptions,
  MrRef,
  MrState,
  RepoRef,
} from './types.js';
