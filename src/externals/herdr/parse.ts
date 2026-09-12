import { asRecord, asString } from '../../util/narrow.js';
import { AGENT_STATUS, type AgentStatus } from './schema.js';

/**
 * Reading Herdr's JSON defensively: every reader here answers with a safe
 * value rather than throwing when the wire disagrees with `schema.ts`.
 */

/** Anything outside Herdr's own set reads as `unknown`. */
export function statusOf(value: unknown): AgentStatus {
  const status = asString(value);
  return (AGENT_STATUS as readonly string[]).includes(status)
    ? (status as AgentStatus)
    : 'unknown';
}

/**
 * The `value` inside Herdr's `agent_session`, which is the agent CLI's own
 * session id. Undefined until the agent's integration has reported one.
 */
export function agentSessionOf(value: unknown): string | undefined {
  const v = asString(asRecord(value).value);
  return v === '' ? undefined : v;
}
