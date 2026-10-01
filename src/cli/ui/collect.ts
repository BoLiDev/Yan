import { readFileSync } from 'node:fs';
import { TASK_STATES, Task, type Deliverable, type TaskData, type TaskState } from '../../records/task/index.js';
import { readJsonOrNone } from '../../util/json.js';
import { isoSecond, localDay } from '../../util/time.js';
import { repoKey } from '../shared/repo-key.js';
import { briefProse } from './brief.js';

/**
 * The data behind `yan ui`: every task, as a reader who has never heard of
 * yan understands it — a task, the problems it was opened for, and what it
 * has to build. The shape is `Report` below, version 3; `--json` prints it
 * and the page is written from it.
 *
 * Read from each task's own files and nothing else, and one task that cannot
 * be read is a task with less in it, never a failure: a task.json whose
 * deliverables do not validate still gives its title, state and days.
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
  /** The repository's name, from its URL; null for a task with none. */
  readonly project: string | null;
  readonly state: TaskState;
  /** `brief.md` as `briefProse` reads it; null when it says nothing. */
  readonly brief: string | null;
  /** Local `YYYY-MM-DD`; null when nothing says. */
  readonly started: string | null;
  /** Local `YYYY-MM-DD`; null while open. */
  readonly completed: string | null;
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

function dayOf(iso: string | undefined): string | null {
  if (iso === undefined) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : localDay(d);
}

/**
 * What can be read of a task.json that does not validate: its title, state
 * and days, as written, and no deliverables.
 */
function looseRead(task: Task): Partial<TaskData> | undefined {
  const raw = readJsonOrNone(task.file);
  if (raw === undefined) return undefined;
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
  const state = TASK_STATES.find((s) => s === raw.state);
  const [title, createdAt, closedAt, repo] = [text(raw.title), text(raw.createdAt), text(raw.closedAt), text(raw.repo)];
  return {
    ...(title === undefined ? {} : { title }),
    ...(state === undefined ? {} : { state }),
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(repo === undefined ? {} : { repo }),
  };
}

function reportTask(id: string): ReportTask {
  const task = new Task(id);
  let data: Partial<TaskData> | undefined;
  try {
    data = task.read();
  } catch {
    data = looseRead(task);
  }
  let brief: string | null = null;
  try {
    brief = briefProse(readFileSync(task.brief, 'utf8'));
  } catch {
    brief = null;
  }
  const repo = data?.repo;
  return {
    id,
    title: data?.title ?? '',
    project: repo === undefined ? null : repoKey(repo).split('/').pop() || null,
    state: data?.state ?? 'open',
    brief,
    started: dayOf(data?.createdAt),
    completed: dayOf(data?.closedAt),
    deliverables: data?.deliverables ?? [],
  };
}

/** The whole report. `range` is what the flags said, or null when there were none. */
export function collectReport(range: ReportRange | null, now: Date = new Date()): Report {
  return { version: 3, generated_at: isoSecond(now), range, tasks: Task.list().map(reportTask) };
}
