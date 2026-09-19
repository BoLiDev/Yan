/**
 * The agent CLIs yan runs — claude, codex, agy — seen from their own files on
 * disk: when an agent last wrote to its session. Read only; nothing here
 * starts or talks to a harness.
 *
 * Every answer is "a time" or "not known", never a throw, because the vault
 * travels between machines and the harnesses do not: a harness that is not
 * installed here, or keeps no file yan can find, is the ordinary case.
 */

export { lastSpoke, harnessEnv, claudeProjectSlug } from './harness.js';
export type { AgentFacts, HarnessEnv, Spoke } from './types.js';
