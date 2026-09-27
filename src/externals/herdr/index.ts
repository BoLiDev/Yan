/**
 * Herdr, the terminal multiplexer, reached through the `herdr` CLI. A failed
 * command throws.
 *
 * One trap for callers: record the pane id, never the label. A name is
 * cleared when its agent exits, which is when yan most needs to identify it.
 */

export { Terminal } from './terminal.js';
export type { TerminalOptions } from './terminal.js';
export { herdrHealth } from './health.js';
export { agentNameFor, isPaneId } from './ids.js';
export { HERDR_PROTOCOL, HERDR_SCHEMA_VERSION, AGENT_STATUS } from './schema.js';
export type {
  AgentStatus,
  Alive,
  Container,
  HerdrHealth,
  ListedAgent,
  PaneRect,
  ReadSource,
  SplitAt,
  SplitDirection,
  StartAgentOptions,
  StartedAgent,
  TabLayout,
} from './types.js';
