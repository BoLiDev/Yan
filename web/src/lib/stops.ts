// Where Tab goes in a task: the rows of its nav that show something on the right, round and round.

import { stateOf, type TaskSummary } from './api';
import { link, type TaskRoute } from './route';

/** Whether a task's agent may be started again from the page: it is open, or handed over to be accepted. */
export const goesOn = (t: TaskSummary): boolean => stateOf(t.state) === 'open' || t.state === 'uat';

/** What a task has beyond what its summary says: a report, resources, a terminal, merge requests. */
export interface Has {
  readonly report?: boolean;
  readonly resources?: boolean;
  readonly terminal?: boolean;
  readonly mergeRequests?: boolean;
}

/** Whether a task has an MR row: a branch it keeps, or a merge request it refers to. */
export const hasMr = (t: TaskSummary, mergeRequests = false): boolean => mergeRequests || t.repos.some((r) => r.branch);

/**
 * A task's stops, top to bottom as its nav has them, each a row's own page:
 * Overview, Report when there is one, Log, Terminal while its agent runs in
 * a herdr pane here or it can be started again, Agent when there is one, MR
 * when it keeps a branch or a merge request, and Resources when there are any.
 */
export function taskStops(t: TaskSummary, has: Has = {}): string[] {
  return [
    link.task(t.id),
    ...(has.report ? [link.report(t.id)] : []),
    link.log(t.id),
    ...(has.terminal ? [link.terminal(t.id)] : []),
    ...(t.agents.length ? [link.agent(t.id)] : []),
    ...(hasMr(t, has.mergeRequests) ? [link.mr(t.id)] : []),
    ...(has.resources ? [link.resources(t.id)] : []),
  ];
}

/** The stop `r` is at: its own row's, MR's for any branch opened from it, none for an artifact. */
function stopAt(stops: readonly string[], r: TaskRoute): number {
  if (r.sub === 'branch') return stops.indexOf(link.mr(r.id));
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
