import type { AgentStatus } from './schema.js';

/** The vocabulary a caller of this module sees. */

export type { AgentStatus } from './schema.js';

/** `unknown` means yan could not find out, never that the agent is confusing. */
export type Alive = 'alive' | 'dead' | 'unknown';

export interface Container {
  readonly workspace: string;
  readonly tab: string;
  readonly pane: string;
}

export interface StartedAgent {
  readonly name: string;
  readonly pane: string;
  readonly status: AgentStatus;
  /** The agent CLI's own session id, when its integration reported one. */
  readonly agent_session?: string;
}

export interface ListedAgent {
  /** The name `agent start` was given; empty for an agent nobody named. */
  readonly name: string;
  readonly pane: string;
  readonly status: AgentStatus;
  /** The agent kind Herdr detected: claude, codex, … */
  readonly kind: string;
  readonly title?: string;
  readonly agent_session?: string;
}

export type ReadSource = 'visible' | 'recent' | 'recent-unwrapped' | 'detection';

export interface StartAgentOptions {
  readonly container: string;
  readonly name: string;
  readonly kind: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly argv?: readonly string[];
  readonly timeoutMs?: number;
  /** What to call the agent's tab. Display only. */
  readonly label?: string;
}

/** What `yan doctor` needs to know about the installed Herdr. */
export interface HerdrHealth {
  readonly version: string;
  readonly protocol: number;
  readonly schemaVersion: number;
  /** kind → state, from `herdr integration status`. Empty when it cannot be read. */
  readonly integrations: Record<string, string>;
}

/**
 * One `pane.agent_status_changed` off the socket — the only event kind that
 * can be subscribed to, so an agent exiting has no push channel at all.
 */
export interface AgentStatusEvent {
  readonly pane: string;
  readonly status: AgentStatus;
  /** The agent kind Herdr detected: claude, codex, … Empty when it did not say. */
  readonly kind: string;
}

/** A connection that has ended, and why, as far as this side can tell. */
export interface ClosedEvent {
  readonly reason: string;
}
