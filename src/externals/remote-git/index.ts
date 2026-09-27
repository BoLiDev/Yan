/**
 * The remote git host: GitHub or GitLab behind four verbs. Return values are a
 * closed set defined by yan, never the host's own words.
 */

export { RemoteGit, configuredCli } from './remote-git.js';
export type { MergeStrategy, MrCreateOptions, MrRef, MrState } from './types.js';
