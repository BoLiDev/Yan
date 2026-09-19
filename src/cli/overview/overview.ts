import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Task, type TaskData } from '../../records/task/index.js';
import { activeDeps, taskActive, type ActiveDeps } from './active.js';
import { poolLeases, taskChanged, type Changed, type LeasesOf } from './changed.js';
import { briefDescription } from './description.js';
import { isoMoment, logTimes, type Moment } from './when.js';

/**
 * What `yan ls` knows about each task: everything its print needs, and
 * nothing it does not. Read from the vault on every call and stored nowhere.
 * No failure anywhere in here fails the command: what cannot be read is
 * unknown, and says so.
 *
 * Cost: the forge is never asked. Git, the pool, Herdr and the harnesses'
 * files are read for open tasks only; a done task is its own files.
 */

export type TaskState = 'open' | 'done' | 'abandoned';
export const STATUS_FILTERS = ['open', 'done', 'all'] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export interface OverviewTask {
  readonly id: string;
  readonly title: string;
  readonly state: TaskState;
  /** The brief's Description, one line per paragraph, paragraphs split by `\n\n`; null when it has none. */
  readonly description: string | null;
  /** `createdAt`, or the first log entry (to the day); null when neither exists. */
  readonly opened: Moment | null;
  /** `closedAt`, or the log's `task marked done` / `task abandoned` entry; null while open. */
  readonly closed: Moment | null;
  /** When the task's code last changed. Null for a done task: its trees are returned and nothing was looked at. */
  readonly changed: Changed | null;
  /** When the task's agents last spoke; the last log entry for a done task. Null when nothing says. */
  readonly active: Moment | null;
}

export interface Overview {
  readonly version: 2;
  readonly status: StatusFilter;
  readonly tasks: readonly OverviewTask[];
  /** How many tasks the filter left out, by state; `abandoned` counts as done. */
  readonly hidden: { readonly open: number; readonly done: number };
}

export interface OverviewDeps {
  readonly now: Date;
  readonly leasesOf: LeasesOf;
  readonly active: ActiveDeps;
}

function read(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function stateOf(data: TaskData): TaskState {
  return data.abandoned ? 'abandoned' : data.complete ? 'done' : 'open';
}

/** Each task, from its own files alone; a task.json that cannot be read is an open task with no title. */
function load(id: string): { task: Task; data: TaskData } {
  const task = new Task(id);
  try {
    return { task, data: task.read() };
  } catch {
    return { task, data: { version: 1, id, title: '', complete: false, abandoned: false, units: [] } };
  }
}

function describe(task: Task, data: TaskData, deps: OverviewDeps): OverviewTask {
  const state = stateOf(data);
  const open = state === 'open';
  const brief = read(join(task.dir, 'brief.md'));
  const log = logTimes(read(join(task.dir, 'log.md')) ?? '', deps.now);

  let active: Moment | undefined = log.last;
  if (open) active = taskActive(task.id, log.last, deps.active);

  return {
    id: data.id || task.id,
    title: data.title,
    state,
    description: brief === undefined ? null : briefDescription(brief),
    opened: isoMoment(data.createdAt, 'task.json') ?? log.opened ?? null,
    closed: open ? null : (isoMoment(data.closedAt, 'task.json') ?? log.closed ?? null),
    changed: open ? taskChanged({ ...data, id: task.id }, deps.leasesOf) : null,
    active: active ?? null,
  };
}

/** Every task the filter lets through, in id order, and the count of the rest. */
export function overview(status: StatusFilter = 'open', deps: Partial<OverviewDeps> = {}): Overview {
  const full: OverviewDeps = {
    now: deps.now ?? new Date(),
    leasesOf: deps.leasesOf ?? poolLeases(),
    active: deps.active ?? activeDeps(),
  };
  const hidden = { open: 0, done: 0 };
  const tasks: OverviewTask[] = [];
  for (const id of Task.list()) {
    const { task, data } = load(id);
    const open = !data.complete;
    const shown = status === 'all' || (status === 'open') === open;
    if (!shown) {
      if (open) hidden.open++;
      else hidden.done++;
      continue;
    }
    tasks.push(describe(task, data, full));
  }
  return { version: 2, status, tasks, hidden };
}
