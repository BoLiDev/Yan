/**
 * herdr, the terminal multiplexer an agent may be started in: which pane yan
 * is in, the pane read and typed into through herdr's socket, the tab it is
 * in split and closed, and a new tab opened.
 */

export { CONTROL_SINCE, atLeast, call, closePane, closeTab, control, controlCommand, createTab, herdrPane, layoutOf, paneOf, panesIn, scrollPane, sendInput, sendKeys, sendText, serverOf, splitPane, tabOf, versionOf } from './client.js';
export type { AgentStatus, Frame, Layout, Pane, Server } from './client.js';
