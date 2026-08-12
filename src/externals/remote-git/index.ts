/**
 * The remote git host: GitHub or GitLab behind four verbs.
 *
 * RETURN VALUES ARE A CLOSED SET DEFINED BY YAN, NEVER THE HOST'S OWN WORDS.
 * `MrState` and `CiState` are yan's vocabulary; a host phrase that leaks past
 * this boundary is one every caller then has to know two spellings of.
 *
 * `configuredCli()` exists separately from `RemoteGit` because bootstrap has to
 * know which CLI to look for before there is a host to construct.
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
