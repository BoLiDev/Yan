/**
 * Herdr, the terminal multiplexer, reached two ways: the `herdr` CLI for
 * commands (`Terminal`) and a socket for the event stream (`TerminalEvents`).
 * A failed command is a `TerminalError`; `EventsError`'s `closed` is a state
 * that arrives and means reconnect.
 *
 * Two traps for callers. Record the pane id, never the label, and never focus
 * a shift's pane — focusing marks the tab seen, which turns the `done` that
 * would have woken yan into an `idle` it ignores. And check `isPaneId` before
 * subscribing: one unknown pane is refused whole, taking every other
 * subscription on that connection with it.
 */

export { Terminal } from './terminal.js';
export type { TerminalOptions } from './terminal.js';
export { TerminalEvents } from './events.js';
export type { TerminalEventsOptions } from './events.js';
export { herdrHealth } from './health.js';
export { isPaneId } from './ids.js';
export { TerminalError, EventsError } from './errors.js';
export { HERDR_PROTOCOL, HERDR_SCHEMA_VERSION, AGENT_STATUS } from './schema.js';
export type {
  AgentStatus,
  AgentStatusEvent,
  Alive,
  ClosedEvent,
  Container,
  HerdrHealth,
  ListedAgent,
  ReadSource,
  StartAgentOptions,
  StartedAgent,
} from './types.js';
