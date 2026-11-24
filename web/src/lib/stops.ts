// Where Tab goes in a task: the rows of its nav that show something on the right, round and round.

import { stateOf, type TaskSummary } from './api';
import { link, type TaskRoute } from './route';

/** Whether a task is paused: put aside, open or in review as it was, its worktrees given back, no agent started on it. */
export const isPaused = (t: Pick<TaskSummary, 'state' | 'pausedAt'>): boolean => !!t.pausedAt && (stateOf(t.state) === 'open' || t.state === 'uat');

/** Whether a task's agent may be started again from the page: it is open, or handed over to be accepted, and not paused. */
export const goesOn = (t: TaskSummary): boolean => (stateOf(t.state) === 'open' || t.state === 'uat') && !isPaused(t);

/**
 * The pages of a task a reader can leave out of its nav, in the settings,
 * by the row's name there: every one but the Overview, which is where a
 * task is landed on. One left out is still there by its address.
 */
export const PAGES = ['principles', 'report', 'log', 'terminal', 'agent', 'mr', 'resources'] as const;
export type Page = (typeof PAGES)[number];
export const PAGE_WORD: Readonly<Record<Page, string>> = { principles: 'Principles', report: 'Report', log: 'Log', terminal: 'Terminal', agent: 'Agent', mr: 'MR', resources: 'Resources' };

/** What a task has beyond what its summary says: principles, a report, resources, a terminal; and the pages the reader left out. */
export interface Has {
  readonly principles?: boolean;
  readonly hidden?: readonly string[];
  readonly report?: boolean;
  readonly resources?: boolean;
  readonly terminal?: boolean;
}

/** Whether a task has an MR row: it keeps a branch. */
export const hasMr = (t: TaskSummary): boolean => t.repos.some((r) => r.branch);

/**
 * A task's stops, top to bottom as its nav has them, each a row's own page,
 * less the ones the reader left out: Overview, Principles when the user
 * recorded any, Report when there is one, Log, Terminal while its agent runs in
 * a herdr pane here or it can be started again, Agent when there is one, MR
 * when it keeps a branch, and Resources when there are any.
 */
export function taskStops(t: TaskSummary, has: Has = {}): string[] {
  const shown = (page: Page, there: boolean): string[] => (there && !(has.hidden ?? []).includes(page) ? [link[page](t.id)] : []);
  return [
    link.task(t.id),
    ...shown('principles', has.principles === true),
    ...shown('report', has.report === true),
    ...shown('log', true),
    ...shown('terminal', has.terminal === true),
    ...shown('agent', t.agents.length > 0),
    ...shown('mr', hasMr(t)),
    ...shown('resources', has.resources === true),
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
