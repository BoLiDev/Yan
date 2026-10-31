/**
 * herdr, the terminal multiplexer an agent may be started in: which pane yan
 * is in, and the pane read and typed into through herdr's socket.
 */

export { OBSERVE_SINCE, atLeast, call, herdrPane, observe, paneOf, paneSize, sendInput, sendKeys, sendText, versionOf } from './client.js';
export type { AgentStatus, Frame, Pane } from './client.js';
