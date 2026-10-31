/**
 * herdr, the terminal multiplexer an agent may be started in: which pane yan
 * is in, the pane read and typed into through herdr's socket, and the tab it
 * is in split and closed.
 */

export { CONTROL_SINCE, atLeast, call, closePane, control, controlCommand, herdrPane, layoutOf, paneOf, panesIn, scrollPane, sendInput, sendKeys, sendText, splitPane, versionOf } from './client.js';
export type { AgentStatus, Frame, Layout, Pane } from './client.js';
