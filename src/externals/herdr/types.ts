import type { AgentStatus } from './schema.js';

/**
 * The vocabulary a caller of this module sees.
 *
 * `AgentStatus` is re-exported from the generated schema rather than restated
 * here: it is Herdr's own closed set, and a copy would drift from what the
 * installed binary actually sends.
 */

export type { AgentStatus } from './schema.js';

/**
 * yan's three words, never Herdr's. `unknown` is reserved for "yan could not
 * find out", never for "yan found out something confusing".
 */
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
  /**
   * The name `agent start` was given. empty for an agent `user` started by
   * hand — Herdr leaves `name` null unless some automation set it — so this
   * cannot be used to find an agent, only to recognise one yan started.
   */
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
  /** Split this pane instead of the container's first pane. */
  readonly fromPane?: string;
  /** `down` by default: a sibling pane in the current tab, never a new tab. */
  readonly direction?: 'right' | 'down';
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
 * One `pane.agent_status_changed` off the socket.
 *
 * The only event kind yan subscribes to, and not by preference: `pane_exited`
 * is in Herdr's `EventKind` but not in `SubscriptionEventKind`, and
 * `events.wait` refuses it too. "The agent died" therefore has no push channel
 * at all, which is why supervision still polls for liveness.
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
