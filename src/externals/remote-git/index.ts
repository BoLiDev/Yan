/**
 * The remote git host — one of yan's three externals (architecture.md §4.3).
 *
 * What this module provides, in full:
 *
 *   new RemoteGit()                    the host this machine is configured for
 *     .createMr(options) → string      open a merge request, return its URL
 *     .mrState(ref)      → MrState     merged | closed | open | unknown
 *     .mergeMr(options)  → void        merge it, now
 *     .ciState(ref)      → CiState     green | red | pending | none
 *
 *   configuredCli()      → 'gh' | 'glab'
 *     Which CLI to check for. Bootstrap needs this before there is anything to
 *     construct, and must check exactly one.
 *
 * Four verbs and one question. Everything else here is how: `provider` (what
 * differs between the two hosts), `github` / `gitlab` (the two answers),
 * `config` (the only reader of the config section), `client` (the only place a
 * CLI runs), `validate` (what is checked first), `types` (the closed sets).
 *
 * The rule the whole module exists to hold:
 *
 *   RETURN VALUES ARE A CLOSED SET DEFINED BY YAN, NEVER THE HOST'S OWN WORDS.
 *
 * Whether a merge request merged is the host's answer, never git ancestry — a
 * squash merge is not an ancestor of what it landed on (CLAUDE.md rule 1).
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
