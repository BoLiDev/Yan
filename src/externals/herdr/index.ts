/**
 * herdr, the terminal multiplexer an agent may be started in: which pane yan
 * is in, and the pane read and typed into through herdr's socket.
 */

export { CONTROL_SINCE, atLeast, call, control, controlCommand, herdrPane, paneOf, scrollPane, sendInput, sendKeys, sendText, versionOf } from './client.js';
export type { AgentStatus, Frame, Pane } from './client.js';
