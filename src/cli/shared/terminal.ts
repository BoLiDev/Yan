/**
 * What a command that tears something down needs from the terminal. `Terminal`
 * is the real one; a test passes its own. `agentAlive` is optional because
 * only `yan shift done` asks — it reports an agent that survived the close
 * rather than assuming it went.
 */
export interface Closer {
  close(pane: string): void;
  clearPaneTitle(pane: string): void;
  agentAlive?(pane: string): 'alive' | 'dead' | 'unknown';
}
