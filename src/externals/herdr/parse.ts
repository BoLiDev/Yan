import type { AgentStatus } from './schema.js';

/**
 * Reading Herdr's JSON defensively: every reader here answers with a safe
 * value rather than throwing when the wire disagrees with `schema.ts`.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Anything outside Herdr's own set reads as `unknown`. */
export function statusOf(value: unknown): AgentStatus {
  const s = str(value);
  return s === 'idle' || s === 'working' || s === 'blocked' || s === 'done' ? s : 'unknown';
}

/**
 * The `value` inside Herdr's `agent_session`, which is the agent CLI's own
 * session id. Undefined until the agent's integration has reported one.
 */
export function agentSessionOf(value: unknown): string | undefined {
  const v = str(asRecord(value).value);
  return v === '' ? undefined : v;
}
