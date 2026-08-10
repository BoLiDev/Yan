/**
 * Herdr's event stream — the socket half of the terminal (supervision.md §2).
 *
 * A second module for one outside authority, and the Phase 5 spike is why:
 * `events.subscribe` has no CLI verb at all, so it cannot go behind
 * `src/externals/terminal/`'s transport, and on Windows the socket is a named
 * pipe whose name is the `.sock` path (evidence §11.1).
 *
 * What this module provides, in full:
 *
 *   new TerminalEvents({ endpoint? })
 *     .open()                  connect, or `events_unreachable`
 *     .subscribe(panes)        one subscription per pane id
 *     .reconnect(panes?)       a fresh connection, then subscribe again
 *     .onStatus(handler)       pane.agent_status_changed, as yan's vocabulary
 *     .onClosed(handler)       the subscription ended; the caller decides what next
 *     .close() · .connected · .subscribed
 *
 *   herdrSocketPath() · endpointFor(path, platform) · defaultEndpoint()
 *     The Windows pipe-name rule, on its own so it can be read and tested
 *     without a Herdr.
 *
 * What it deliberately does NOT provide: `pane_exited`. It is in Herdr's event
 * schema but not in its SUBSCRIPTION schema, and `events.wait` refuses it too
 * (evidence §11.2). "The agent died and cannot say so" has no push channel on
 * this build, which is exactly why `yan wait` still polls for liveness.
 */

export { TerminalEvents, isPaneId } from './client.js';
export type { TerminalEventsOptions } from './client.js';
export { EventsError } from './errors.js';
export { defaultEndpoint, endpointFor, herdrSocketPath } from './socket.js';
export { AGENT_STATUS } from './types.js';
export type { AgentStatus, AgentStatusEvent, ClosedEvent } from './types.js';
