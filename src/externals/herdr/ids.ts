import { TerminalError } from './errors.js';

/**
 * Herdr's identifiers, and the guards that keep a label from being passed where
 * one is required.
 *
 * `w1`, or `w1:p1`. opaque and stable; never reused after close.
 *
 * Opaque is meant literally, and it is easy to get wrong, because `w1` and
 * `w1:p1` are only the shape: after enough workspaces Herdr hands out `wB` and
 * `wB:p2`. So these guards check the part a caller could confuse with a label —
 * a `w…` prefix, a `:p…` suffix — and nothing about what is inside. Never parse
 * an id, never sort by one, never generate one.
 */

const WORKSPACE_ID = /^w[0-9A-Za-z]+$/;
const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;
/** Herdr's own rule for an agent name. */
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Could Herdr have issued this id? A predicate rather than a guard, because
 * callers have to be able to ask before subscribing.
 *
 * A subscription naming one pane herdr does not know is refused whole, and the
 * connection closes with it — so a single bad id costs every other shift its
 * subscription. That is too expensive to leave to a caller's judgement.
 *
 * The ids being checked come off disk, not from Herdr. `run/meta.json` is
 * long-lived and nothing migrates it, so a pane id in a task directory is
 * whatever the yan that wrote it believed — including the empty string, which
 * `shift new` writes for the window between recording a dispatch and the agent
 * actually starting. A record older than the process reading it is the ordinary
 * case here, not an edge one.
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
