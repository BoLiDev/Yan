import { Task } from '../../records/task/index.js';
import { taskFiles, type TaskState } from '../overview/overview.js';
import type { Moment } from '../overview/when.js';
import { parseBrief, type Deliverable } from './brief.js';

/**
 * The data behind `yan ui`: every task, as a reader who has never heard of
 * yan understands it — a task and its deliverables, nothing of yan's own. The
 * shape is `artifacts/uix-html/data-shape.md` of task t128; `--json` prints
 * it and the page is written from it.
 *
 * Read from each task's own files and nothing else: the forge, git, the pool
 * and Herdr are never asked, and one task that cannot be read is a task with
 * less in it, never a failure.
 */

/** Both ends inclusive, local `YYYY-MM-DD`; either may be null. */
export interface ReportRange {
  readonly since: string | null;
  readonly until: string | null;
}

export interface ReportTask {
  /** A key for the page, never printed. */
  readonly id: string;
  /** "" when task.json cannot be read. */
  readonly title: string;
  /** The `repo` of the first unit; null with none. */
  readonly project: string | null;
  readonly state: TaskState;
  /** The first paragraph of the brief's Description; null unless the brief has the stated shape. */
  readonly description: string | null;
  /** Local `YYYY-MM-DD`; null when nothing says. */
  readonly started: string | null;
  /** Local `YYYY-MM-DD`; null while open. */
  readonly completed: string | null;
  /** Empty when the brief has none, or is not in the shape. */
  readonly deliverables: readonly Deliverable[];
}

export interface Report {
  readonly version: 2;
  /** ISO 8601 UTC to the second: the page's "today". */
  readonly generated_at: string;
  readonly range: ReportRange | null;
  /** Every task, open, done and abandoned, in id order. */
  readonly tasks: readonly ReportTask[];
}

const two = (n: number): string => String(n).padStart(2, '0');

/** The local calendar day of a date. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** A moment reduced to its local day: the report has no use for the hour. */
function dayOf(m: Moment | null): string | null {
  if (m === null) return null;
  return m.precision === 'day' ? m.at : localDay(new Date(m.at));
}

export function reportTask(id: string, now: Date): ReportTask {
  const { task, data, brief } = taskFiles(id, now);
  const completed = dayOf(task.closed);
  const notAfter = task.state === 'open' ? localDay(now) : (completed ?? localDay(now));
  const parsed = parseBrief(brief, notAfter);
  const shaped = parsed.shape === 'sections';
  return {
    id: task.id,
    title: task.title,
    project: data.units[0]?.repo || null,
    state: task.state,
    description: shaped ? (task.description?.split('\n\n')[0] ?? null) : null,
    started: dayOf(task.opened),
    completed,
    deliverables: parsed.deliverables,
  };
}

/** The whole report. `range` is what the flags said, or null when there were none. */
export function collectReport(range: ReportRange | null, now: Date = new Date()): Report {
  return {
    version: 2,
    generated_at: `${now.toISOString().slice(0, 19)}Z`,
    range,
    tasks: Task.list().map((id) => reportTask(id, now)),
  };
}
