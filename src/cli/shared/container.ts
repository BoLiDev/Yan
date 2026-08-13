import { Shift } from '../../records/shift/index.js';
import { paneOfEnterLock } from './enter-lock.js';

/**
 * Which terminal container a task's work belongs in: one workspace per task,
 * holding the main agent's pane and a tab per shift.
 *
 * Answered by id and never by label, which Herdr does not keep unique — first
 * from what a live shift of this task recorded, then from the workspace the
 * main agent's own pane is in.
 */

/** What container resolution needs from the terminal; `Terminal` is the real one. */
export interface ContainerTerminal {
  workspaceOfPane(pane: string): string | undefined;
}

/**
 * The task's container, or `undefined` when it has none on screen yet. Creates
 * nothing. Without a `terminal`, only what a shift recorded is consulted.
 */
export function containerOf(task: string, terminal?: ContainerTerminal): string | undefined {
  for (const shift of Shift.liveIn(task)) {
    const container = shift.meta().container;
    if (container !== undefined && container !== '') return container;
  }
  if (terminal === undefined) return undefined;
  const pane = paneOfEnterLock(task);
  return pane === undefined ? undefined : terminal.workspaceOfPane(pane);
}

/** What creating a container needs from the terminal. */
export interface CreatingTerminal extends ContainerTerminal {
  createContainer(label: string): { workspace: string };
}

/**
 * The task's container, creating one labelled `label` when there is nowhere to
 * join — which is what a yan running outside Herdr meets.
 */
export function resolveContainer(task: string, terminal: CreatingTerminal, label: string): string {
  return containerOf(task, terminal) ?? terminal.createContainer(label).workspace;
}
