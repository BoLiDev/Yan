import { TerminalError } from './errors.js';

/**
 * Herdr's identifiers, and the guards that keep a label from being passed where
 * one is required.
 *
 * `w1`, or `w1:p1`. OPAQUE and stable; never reused after close.
 *
 * Opaque is meant literally, and it is easy to get wrong: terminal.md §3 gives
 * `w1` and `w1:p1` as the SHAPE, and after enough workspaces this Herdr hands
 * out `wB` and `wB:p2`. So the guards check the shape a caller could confuse
 * with a label — a `w…` prefix, a `:p…` suffix — and nothing about what is
 * inside them. Never parse an id, never sort by one, never generate one.
 */

const WORKSPACE_ID = /^w[0-9A-Za-z]+$/;
const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;
/** Herdr's own rule for an agent name. */
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Could Herdr have issued this id?
 *
 * The predicate rather than the guard, because a caller has to be able to ask
 * BEFORE subscribing: **a subscription naming one pane Herdr does not know is
 * refused WHOLE**, and the connection closes with it ([evidence
 * §12.1](../../../docs/v2/td/evidence.md)). One bad id therefore costs every
 * other shift its subscription, which is why the check is here and not left to
 * the caller's judgement.
 *
 * Its original example — a `%7` left by a shift the tmux half dispatched — went
 * with tmux in Phase 9. THE CHECK DID NOT, and the reason it outlives the
 * example is worth stating plainly, because "the thing this guarded against is
 * gone" is how a guard gets deleted:
 *
 *   the ids come off DISK, not from Herdr. `run/meta.json` is long-lived and
 *   nothing migrates it, so a pane id in a task directory is whatever the yan
 *   that wrote it believed — including the empty string, which `shift new`
 *   writes for the window between recording the dispatch and the agent
 *   starting. A record older than the process reading it is the ordinary case
 *   here, not the legacy one.
 */
export function isPaneId(value: string): boolean {
  return PANE_ID.test(value);
}

export function requirePaneId(value: string, what: string): string {
  if (!isPaneId(value)) {
    throw TerminalError.usage(`${what} needs a pane id like w1:p1, never a label: got '${value}'`);
  }
  return value;
}

export function requireWorkspaceId(value: string, what: string): string {
  if (!WORKSPACE_ID.test(value)) {
    throw TerminalError.usage(`${what} needs a workspace id like w1, never a name: got '${value}'`);
  }
  return value;
}

export function requireAgentName(value: string): string {
  if (!AGENT_NAME.test(value)) {
    throw TerminalError.usage(`an agent name is [a-z][a-z0-9_-]{0,31}: got '${value}'`);
  }
  return value;
}

/** A pane belongs to a workspace when its id carries that prefix. */
export function paneIsIn(pane: string, container: string): boolean {
  return pane.startsWith(`${container}:`);
}
