import { TerminalError } from './errors.js';

/**
 * Herdr's identifiers — `w1` for a workspace, `w1:p1` for a pane — and the
 * guards that keep a label from being passed where one is required. The
 * suffixes are not numbers (`wB:p2` is a real id), so these check the shape
 * and nothing inside it.
 */

const WORKSPACE_ID = /^w[0-9A-Za-z]+$/;
const PANE_ID = /^w[0-9A-Za-z]+:p[0-9A-Za-z]+$/;
/** Herdr's own rule for an agent name. */
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Could Herdr have issued this id? A predicate rather than a guard, for
 * callers checking an id that came off disk before they act on it.
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
