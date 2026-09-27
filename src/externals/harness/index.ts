/**
 * The agent CLIs yan runs — claude, codex, agy — and everything yan knows about
 * each: how it is started (`launch.ts`), when an agent last wrote to its
 * session file (`spoke.ts`), and what its screen shows in the prompt box.
 * Nothing here starts or talks to a harness: it answers what the argv is, and
 * the cli layer, or Herdr, runs it.
 *
 * Every answer about a running agent is "a time" or "not known", never a throw, because the vault
 * travels between machines and the harnesses do not: a harness that is not
 * installed here, or keeps no file yan can find, is the ordinary case.
 */

export { lastSpoke, harnessEnv, claudeProjectSlug } from './spoke.js';
export {
  cliKind,
  codexConfigFile,
  codexTrustsHooks,
  herdrIntegration,
  hooksFile,
  isKnownCli,
  launchArgs,
  promptInArgv,
} from './launch.js';
export { typedInput } from './typed-input.js';
export type { AgentFacts, HarnessEnv } from './types.js';
export type { HarnessKind, Launch } from './launch.js';
