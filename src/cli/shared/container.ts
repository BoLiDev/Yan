import { Shift } from '../../records/shift/index.js';
import { paneOfEnterLock } from './enter-lock.js';

/**
 * Which terminal container a task's work belongs in.
 *
 * One task, one container, and everything the task has on screen inside it: the
 * main agent in the pane `user` typed in, and every shift in a tab of its own
 * beside it. `user` watches one workspace and sees the whole task.
 *
 * That is a change from creating a container per dispatch, which produced one
 * workspace per shift, all carrying the same label, with yan itself in a fourth
 * — and left `unit set --branch` labelling whichever of them a shift happened
 * to be listed in first.
 *
 * Three answers, in this order, and the order is the design:
 *
 *   1. The container a live shift of this task recorded. Once one shift is
 *      placed, the rest follow it, so the answer cannot drift mid-task even if
 *      the main agent is restarted somewhere else.
 *   2. The workspace the main agent's own pane is in, from the enter lock. This
 *      is what puts the first shift beside `user` rather than somewhere new.
 *   3. Nothing. There is no container yet, and what that means is the caller's
 *      to decide: `resolveContainer` creates one, and the relabelling callers
 *      do not.
 *
 * Never by label. Herdr does not enforce that workspace labels are unique, so a
 * search for `t103 alter blade` can find `user`'s own workspace that happens to
 * carry that label, and yan would start opening tabs in it. Both answers
 * above are ids — one recorded by a shift, one stamped on a lock by the process
 * that is in that pane. This is the same rule as `task.json` over branch names,
 * applied to the screen.
 */

/** What container resolution needs from the terminal; `Terminal` is the real one. */
export interface ContainerTerminal {
  workspaceOfPane(pane: string): string | undefined;
}

/**
 * The task's container, or `undefined` when it has none on screen yet.
 *
 * Creates nothing. A command that only wants to relabel has no business
 * creating a workspace, and "nothing is running, so there is nothing to
 * relabel" is not a failure.
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
 * The task's container, creating one only when there is genuinely nowhere to
 * join.
 *
 * The third answer is reached by a yan running outside Herdr, and by a shift
 * dispatched after the main agent's pane has gone. Creating then is right —
 * the alternative is refusing to dispatch over a display concern — and it is
 * still one container for the task, because the shift that creates it records
 * it and answer 1 hands it to every shift after.
 */
export function resolveContainer(task: string, terminal: CreatingTerminal, label: string): string {
  return containerOf(task, terminal) ?? terminal.createContainer(label).workspace;
}
