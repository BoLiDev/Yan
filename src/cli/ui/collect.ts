import { readDeliverables, Task, type Deliverable } from '../../records/task/index.js';
import { taskFiles, type TaskState } from '../overview/overview.js';
import type { Moment } from '../overview/when.js';

/**
 * The data behind `yan ui`: every task, as a reader who has never heard of
 * yan understands it — a task, the problems it was opened for, and what it
 * has to build. Nothing of yan's own. The shape is
 * `artifacts/uix-html/data-shape-v3.md` of task t128; `--json` prints it and
 * the page is written from it.
 *
 * Read from each task's own files and nothing else: the forge, git, the pool
 * and Herdr are never asked, and one task that cannot be read is a task with
 * less in it, never a failure. A `deliverable.json` that does not validate is
 * a task with no deliverables, which the page draws as `unknown`.
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
  /**
   * `brief.md` as `briefDescription` reads it: the prose under the title
   * line, paragraphs a blank line apart and a bullet on its own line. Null
   * when there is no brief, or nothing under its title.
   */
  readonly brief: string | null;
  /** Local `YYYY-MM-DD`; null when nothing says. */
  readonly started: string | null;
  /** Local `YYYY-MM-DD`; null while open. */
  readonly completed: string | null;
  /** `deliverable.json` as it is, in file order; empty when there is none. */
  readonly deliverables: readonly Deliverable[];
}

export interface Report {
  readonly version: 3;
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
  const { task, data } = taskFiles(id, now);
  return {
    id: task.id,
    title: task.title,
    project: data.units[0]?.repo || null,
    state: task.state,
    brief: task.description,
    started: dayOf(task.opened),
    completed: dayOf(task.closed),
    deliverables: readDeliverables(id).deliverables,
  };
}

/** The whole report. `range` is what the flags said, or null when there were none. */
export function collectReport(range: ReportRange | null, now: Date = new Date()): Report {
  return {
    version: 3,
    generated_at: `${now.toISOString().slice(0, 19)}Z`,
    range,
    tasks: Task.list().map((id) => reportTask(id, now)),
  };
}
