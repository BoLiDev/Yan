/**
 * The agent CLIs yan runs — claude, codex, agy — seen from the outside: when
 * an agent last wrote to its session file, and what its screen shows in the
 * prompt box. Read only; nothing here starts or talks to a harness.
 *
 * Every answer is "a time" or "not known", never a throw, because the vault
 * travels between machines and the harnesses do not: a harness that is not
 * installed here, or keeps no file yan can find, is the ordinary case.
 */

export { lastSpoke, harnessEnv, claudeProjectSlug } from './harness.js';
export { typedInput } from './typed-input.js';
export type { AgentFacts, HarnessEnv } from './types.js';
