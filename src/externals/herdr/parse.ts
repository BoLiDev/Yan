import type { AgentStatus } from './schema.js';

/**
 * Reading Herdr's JSON defensively.
 *
 * Every field is optional as far as this module is concerned: Herdr ships on a
 * preview channel, response shapes have moved between builds, and a missing key
 * must degrade to a safe value rather than throw somewhere unrelated. The
 * generated types in `schema.ts` say what the contract is; these say what to do
 * when the wire disagrees with it.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Anything Herdr does not classify confidently is `unknown` — not a guess. */
export function statusOf(value: unknown): AgentStatus {
  const s = str(value);
  return s === 'idle' || s === 'working' || s === 'blocked' || s === 'done' ? s : 'unknown';
}

/**
 * `pane list` returns `agent_session: {kind:"id", source:"herdr:claude", value}`
 * and the value is the agent CLI's own session id. It arrives via the
 * integration's SessionStart hook, so its ABSENCE IS NORMAL, not an error
 * (terminal.md §7).
 */
export function agentSessionOf(value: unknown): string | undefined {
  const v = str(asRecord(value).value);
  return v === '' ? undefined : v;
}
