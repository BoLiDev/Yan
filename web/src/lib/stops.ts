// Where Tab goes in a task: the rows of its nav that show something on the right, round and round.

import { stateOf, type TaskSummary } from './api';
import { link, type TaskRoute } from './route';

/**
 * A task's stops, top to bottom as its nav has them: Overview, Report when
 * there is one, Log, Terminal while its agent runs in a herdr pane here,
 * Agent when there is one, MR, which shows the branch its first tree is on,
 * and Resources when there are any.
 */
/** Whether a task's agent may be started again from the page: it is open, or handed over to be accepted. */
export const goesOn = (t: TaskSummary): boolean => stateOf(t.state) === 'open' || t.state === 'uat';

export function taskStops(t: TaskSummary, hasReport: boolean, hasResources = false, hasTerminal = false): string[] {
  const repo = t.repos.findIndex((r) => r.branch);
  return [
    link.task(t.id),
    ...(hasReport ? [link.report(t.id)] : []),
    link.log(t.id),
    ...(hasTerminal ? [link.terminal(t.id)] : []),
    ...(t.agents.length ? [link.agent(t.id)] : []),
    ...(repo >= 0 ? [link.branch(t.id, repo)] : []),
    ...(hasResources ? [link.resources(t.id)] : []),
  ];
}

/** The stop `r` is at: its own row's, MR's for any branch, none for an artifact. */
function stopAt(stops: readonly string[], r: TaskRoute): number {
  if (r.sub === 'branch') return stops.findIndex((s) => s.startsWith(`#/t/${r.id}/b/`));
  if (r.sub === 'file' || r.sub === 'folder') return -1;
  return stops.indexOf(r.sub === 'overview' ? link.task(r.id) : link[r.sub](r.id));
}

/**
 * The stop after the one `r` is at, or before it going back, round from the
 * last to the first; from an artifact, which is at none, the first or the
 * last.
 */
export function nextStop(stops: readonly string[], r: TaskRoute, back: boolean): string | undefined {
  const n = stops.length;
  const at = stopAt(stops, r);
  return n === 0 ? undefined : stops[at < 0 ? (back ? n - 1 : 0) : (at + (back ? n - 1 : 1)) % n];
}
