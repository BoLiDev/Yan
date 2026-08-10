import type { AgentStatus } from './schema.js';

/**
 * The vocabulary a caller of this module sees.
 *
 * `AgentStatus` is re-exported from the generated schema rather than restated
 * here: it is Herdr's own closed set, and copying it would let the copy drift
 * from what the binary actually sends.
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
   * The name `agent start` was given. Empty for an agent `user` started by
   * hand: Herdr's `name` is null unless yan (or another automation) named it,
   * which is one more reason the pane id is what gets recorded.
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
