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

/**
 * What `user` has typed into a Claude Code prompt box and not sent yet, read
 * off the visible screen. `''` is a box that is there and empty; `undefined`
 * is no box this can make out — a dialog is up, the transcript viewer is
 * open, the harness draws its input some other way — so the caller has
 * nothing to wait for.
 *
 * The box is the last stretch between two horizontal rules whose first line
 * opens with `❯`; a long entry wraps onto the lines below that one.
 */
export function typedInput(screen: string): string | undefined {
  const lines = screen.split('\n');
  const isRule = (line: string): boolean => /^\s*─{8,}\s*$/.test(line);

  let bottom = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (isRule(lines[i] ?? '')) {
      bottom = i;
      break;
    }
  }
  let top = -1;
  for (let i = bottom - 1; i >= 0; i -= 1) {
    if (isRule(lines[i] ?? '')) {
      top = i;
      break;
    }
  }
  if (top < 0) return undefined;

  const body = lines.slice(top + 1, bottom);
  const first = (body[0] ?? '').trimStart();
  if (!first.startsWith('❯')) return undefined;
  return [first.slice(1), ...body.slice(1)]
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join(' ');
}
