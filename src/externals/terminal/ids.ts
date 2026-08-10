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

export function requirePaneId(value: string, what: string): string {
  if (!PANE_ID.test(value)) {
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
