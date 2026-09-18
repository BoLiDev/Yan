import type { AgentStatus } from './schema.js';

/** The vocabulary a caller of this module sees. */

export type { AgentStatus, ReadSource } from './schema.js';

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

/** Which way a split puts the new pane: beside its target, or under it. */
export type SplitDirection = 'right' | 'down';

/** Start the agent in a new pane split off `pane`, rather than in a new tab. */
export interface SplitAt {
  readonly pane: string;
  readonly direction: SplitDirection;
}

/** Where a pane sits in its tab, in cells. */
export interface PaneRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The panes of one tab and where each sits, as `pane layout` reports them. */
export interface TabLayout {
  readonly workspace: string;
  readonly tab: string;
  readonly panes: readonly { readonly pane: string; readonly rect: PaneRect }[];
}

export interface StartAgentOptions {
  /** The workspace a new tab is made in. Unused when `split` is given. */
  readonly container: string;
  /**
   * Split this pane and start the agent in the new half, instead of making a
   * tab in `container`.
   */
  readonly split?: SplitAt;
  readonly name: string;
  readonly kind: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly argv?: readonly string[];
  /**
   * The opening prompt, typed in once the agent is at its input line and its
   * startup dialogs are answered. Keep it out of `argv`: herdr's `agent start`
   * returns only when the agent is ready for input, and one that already has
   * its work order is still working at the deadline.
   */
  readonly prompt?: string;
  readonly timeoutMs?: number;
  /** What to call the agent's tab. Display only, and unused for a split. */
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
