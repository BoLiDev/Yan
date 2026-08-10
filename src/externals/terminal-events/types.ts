/**
 * The vocabulary a caller of this module sees.
 *
 * `AgentStatus` is RESTATED here rather than imported from the terminal's
 * generated schema, and that is not an oversight: no module under
 * `src/externals/` may import another (conventions §2), because an external
 * that reaches into another external has started making decisions. The cost is
 * one duplicated union; `tests/unit/agent-status-vocabulary.test.ts` asserts the
 * two sets are identical, so duplication cannot quietly become divergence.
 */

export type AgentStatus = 'idle' | 'working' | 'blocked' | 'done' | 'unknown';

export const AGENT_STATUS: readonly AgentStatus[] = [
  'idle',
  'working',
  'blocked',
  'done',
  'unknown',
];

/**
 * `pane.agent_status_changed`, the one subscribable kind supervision needs.
 *
 * Every `SubscriptionEventKind` is pane-scoped and requires a `pane_id`; a
 * subscription without one is refused with `invalid_request` (evidence §11.2).
 * So this is what a subscription can carry, and `pane_exited` — "the agent died
 * and cannot say so" — is what it cannot: that kind exists in the event schema
 * but not in the subscription schema, and `events.wait` refuses it too. There
 * is no push channel for it at all, which is why the liveness poll survives.
 */
export interface AgentStatusEvent {
  readonly pane: string;
  readonly status: AgentStatus;
  /** The agent kind Herdr detected: claude, codex, … Empty when it did not say. */
  readonly kind: string;
}

/** A subscription that has ended, and why, as far as this side can tell. */
export interface ClosedEvent {
  readonly reason: string;
}
