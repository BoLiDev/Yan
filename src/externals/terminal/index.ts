/**
 * The terminal — one of yan's three externals (architecture.md §4.3).
 *
 * What this module provides, in full:
 *
 *   new Terminal()
 *     .createContainer(label, cwd?)  → Container      a workspace for a task
 *     .startAgent(options)           → StartedAgent   split a pane, start an agent in it
 *     .send(pane, text, waitMs?)     → void           one prompt, atomically
 *     .read(pane, lines?, source?)   → string         what is on its terminal
 *     .agentAlive(pane)              → alive|dead|unknown
 *     .reconcile(name, recordedPane) → string?        the new id after a pane move
 *     .close(pane)                   → void           exactly the recorded pane
 *     .list(container?)              → ListedAgent[]
 *
 *   herdrHealth() → HerdrHealth?
 *     Version, protocol, schema stamp and installed integrations, for
 *     `yan doctor`. Not a method, because doctor asks it precisely when the
 *     terminal may not be usable at all.
 *
 * Everything else here is how: `terminal` (the class), `client` (the only place
 * herdr runs), `ids` (the guards that keep a label out), `parse` (reading
 * Herdr's JSON defensively), `types` (yan's vocabulary), `schema` (GENERATED
 * from `herdr api schema --json` — do not edit).
 *
 * The rule the whole module exists to hold:
 *
 *   RECORD THE ID, NEVER THE LABEL — and never call `agent focus` on a shift's
 *   pane, because focusing marks the tab seen and turns the `done` that would
 *   have woken yan into an `idle` it ignores.
 */

export { Terminal } from './terminal.js';
export { herdrHealth } from './health.js';
export { TERM_BUG, TERM_NOT_FOUND, TERM_REFUSED, TERM_UNREACHABLE } from './client.js';
export { HERDR_PROTOCOL, HERDR_SCHEMA_VERSION } from './schema.js';
export { AGENT_STATUS as AGENT_STATUS_VALUES } from './schema.js';
export type {
  AgentStatus,
  Alive,
  Container,
  HerdrHealth,
  ListedAgent,
  ReadSource,
  StartAgentOptions,
  StartedAgent,
} from './types.js';
