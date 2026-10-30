// Where Tab goes in a task: the rows of its nav, round and round.

import type { TaskSummary } from './api';
import { link, type TaskRoute } from './route';

/** The Agent row's stop, which shows nothing on the right: Tab marks the row, and Enter opens the agent. */
export const AGENT_STOP = 'agent';

/**
 * A task's stops, top to bottom as its nav has them: Overview, Report when
 * there is one, Log, Agent when there is one, and MR, which shows the branch
 * its first tree is on. Each but Agent's is the page it shows.
 */
export function taskStops(t: TaskSummary, hasReport: boolean): string[] {
  const repo = t.repos.findIndex((r) => r.branch);
  return [
    link.task(t.id),
    ...(hasReport ? [link.report(t.id)] : []),
    link.log(t.id),
    ...(t.agents.length ? [AGENT_STOP] : []),
    ...(repo >= 0 ? [link.branch(t.id, repo)] : []),
  ];
}

/** The stop the task is at: Agent's when its row is marked, else the page's own row, MR's for any branch, none for an artifact. */
function stopAt(stops: readonly string[], r: TaskRoute, agent: boolean): number {
  if (agent) return stops.indexOf(AGENT_STOP);
  if (r.sub === 'branch') return stops.findIndex((s) => s.startsWith(`#/t/${r.id}/b/`));
  if (r.sub === 'file' || r.sub === 'folder') return -1;
  return stops.indexOf(r.sub === 'overview' ? link.task(r.id) : link[r.sub](r.id));
}

/**
 * The stop after the one the task is at, or before it going back, round
 * from the last to the first; from an artifact, which is at none, the first
 * or the last.
 */
export function nextStop(stops: readonly string[], r: TaskRoute, agent: boolean, back: boolean): string | undefined {
  const n = stops.length;
  const at = stopAt(stops, r, agent);
  return n === 0 ? undefined : stops[at < 0 ? (back ? n - 1 : 0) : (at + (back ? n - 1 : 1)) % n];
}
