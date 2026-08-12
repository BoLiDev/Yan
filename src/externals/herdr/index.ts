/**
 * Herdr, the terminal multiplexer, reached two ways: the `herdr` CLI for
 * commands (`Terminal`) and a socket for the event stream (`TerminalEvents`).
 *
 * Both transports live here, and splitting them is the tempting mistake.
 * Modules under `externals/` may not import one another, so two modules would
 * each need their own copy of the pane-id shape and the agent-status union.
 * Two transports are not two authorities.
 *
 * Two error classes, deliberately. `TerminalError` is a command that failed.
 * `EventsError`'s `closed` is not a failure at all — it is a state that arrives
 * and means reconnect, and folding the two together would lose that.
 *
 * Two traps this module exists to keep callers out of:
 *
 *   Record the pane ID, never the label, and never call `agent focus` on a
 *   shift's pane. Focusing marks the tab seen, which turns the `done` that
 *   would have woken yan into an `idle` it ignores.
 *
 *   A subscription naming an unknown pane is refused whole — Herdr closes the
 *   connection, taking every other pane's subscription with it. Hence
 *   `isPaneId` and a check against `agent list` before subscribing.
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
