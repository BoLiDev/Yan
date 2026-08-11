/**
 * Herdr — the multiplexer, and one of yan's three externals
 * (architecture.md §4.3, terminal.md).
 *
 * ONE OUTSIDE AUTHORITY, ONE MODULE. Herdr is reached two ways — the `herdr`
 * CLI for commands, a socket for the event stream — and those were briefly two
 * modules. That was a mistake with a visible cost: `externals` may not import
 * each other, so the pane-id shape and the agent-status union were each written
 * twice, and a test existed whose only job was to police the copies. Two
 * transports are not two authorities. The rule was right; the boundary was in
 * the wrong place.
 *
 * What this module provides, in full:
 *
 *   new Terminal(options?)                    the CLI transport
 *     .createContainer(label, cwd?)  → Container
 *     .startAgent(options)           → StartedAgent   split a pane, start an agent, confirm it
 *     .send(pane, text, waitMs?)     → void           refuses a pane with no live agent
 *     .read(pane, lines?, source?)   → string
 *     .agentAlive(pane)              → alive|dead|unknown
 *     .reconcile(name, recordedPane) → string?
 *     .workspaceOfPane(pane)         → string?      which workspace to label
 *     .close(pane) · .list(container?)
 *     .setWorkspaceTokens · .clearWorkspaceTokens · .setPaneTitle · .clearPaneTitle
 *
 *   new TerminalEvents(options?)              the socket transport
 *     .open() · .subscribe(panes) · .reconnect(panes?)
 *     .onStatus(fn) · .onClosed(fn)
 *     .connected · .subscribed
 *
 *   herdrHealth() → HerdrHealth?               version, protocol, integrations, for `yan doctor`
 *   isPaneId(value)                            ask before subscribing, not after
 *
 * TWO ERROR CLASSES, deliberately. `TerminalError` is a command that failed;
 * `EventsError` is the stream, and its `closed` is not a failure at all — it is
 * a state that arrives and means reconnect. Folding them together would lose
 * that distinction and rename wire codes for nothing.
 *
 * The rules this module exists to hold:
 *
 *   RECORD THE ID, NEVER THE LABEL — and never call `agent focus` on a shift's
 *   pane, because focusing marks the tab seen and turns the `done` that would
 *   have woken yan into an `idle` it ignores.
 *
 *   A SUBSCRIPTION NAMING AN UNKNOWN PANE IS REFUSED WHOLE. Herdr closes the
 *   connection and every other pane's subscription goes with it, so panes are
 *   filtered through `isPaneId` and checked against `agent list` first
 *   (evidence §12.1).
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
