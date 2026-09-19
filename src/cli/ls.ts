import { Command, Option } from 'commander';
import { tasksDir } from '../util/vault.js';
import { readJsonIfPresent } from '../util/json.js';
import { Shift } from '../records/shift/index.js';
import { Task } from '../records/task/index.js';
import { action, out } from './shared/action.js';
import { dash, renderTable } from './shared/table.js';
import { overview, STATUS_FILTERS, type StatusFilter } from './overview/overview.js';

/**
 * `yan ls [--status open|done|all] [--json]` — the queue, produced by scanning
 * `tasks/*​/task.json` on every call. Stores nothing. One task in depth is
 * `yan show <id>`: two commands printing the same thing is two commands to
 * keep in step.
 *
 * `--json` is the overview in `overview/overview.ts`, version 2. The table
 * below is the print from before it and is read off the cheap scan that
 * `queue()` still is, which the task pickers share.
 */

export type { Overview, OverviewTask, StatusFilter } from './overview/overview.js';

/** One row of the queue. */
export interface QueueTask {
  readonly id: string;
  readonly title: string;
  readonly complete: boolean;
  readonly abandoned: boolean;
  /** A unit's name, or null when the entry in task.json has none. */
  readonly units: readonly (string | null)[];
  readonly scope: readonly string[];
  /** How many shifts of this task are still live. */
  readonly shifts: number;
}


/** A string field of a file yan did not write: null, absent and false read as empty. */
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return value === null || value === undefined || value === false ? '' : String(value);
}

/** Sorted by code point, deduplicated. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function rawTask(id: string): Record<string, unknown> {
  const raw = readJsonIfPresent(new Task(id).file);
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

function rawUnits(task: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(task.units)
    ? task.units.map((u) =>
        typeof u === 'object' && u !== null ? (u as Record<string, unknown>) : {},
      )
    : [];
}

/** Every task from its task.json and live shifts alone: no git, no Herdr, no forge. */
export function queue(): QueueTask[] {
  const tasks = Task.list().map((id) => {
    const task = rawTask(id);
    const units = rawUnits(task);
    return {
      id: text(task.id),
      title: text(task.title),
      complete: task.complete === true,
      abandoned: task.abandoned === true,
      units: units.map((u) => (typeof u.name === 'string' ? u.name : null)),
      scope: unique(
        units.flatMap((u) =>
          Array.isArray(u.scope) ? u.scope.filter((s): s is string => typeof s === 'string') : [],
        ),
      ),
      shifts: Shift.liveIn(id).length,
    };
  });
  return tasks;
}

/** Whether `--status` lets a task through: `abandoned` counts as done. */
function shown(status: StatusFilter, complete: boolean): boolean {
  return status === 'all' || (status === 'open') !== complete;
}

function renderQueue(tasks: readonly QueueTask[], status: StatusFilter): void {
  if (tasks.length === 0) {
    out(`no tasks in ${tasksDir()}`);
    return;
  }
  const listed = tasks.filter((t) => shown(status, t.complete));
  if (listed.length === 0) {
    out(status === 'open' ? "nothing open - 'yan ls --status all' lists the rest" : "nothing done - 'yan ls' lists what is open");
    return;
  }
  const rows: string[][] = [['ID', 'STATE', 'UNITS', 'SHIFTS', 'SCOPE', 'TITLE']];
  for (const t of listed) {
    rows.push([
      t.id,
      t.abandoned ? 'abandoned' : t.complete ? 'done' : 'open',
      String(t.units.length),
      String(t.shifts),
      dash(t.scope.join(' ')),
      dash(t.title),
    ]);
  }
  for (const line of renderTable(rows)) out(line);
}

export const command = new Command('ls')
  .description('the queue: every task, one line each')
  .addOption(new Option('--status <status>', 'which tasks: open, done (abandoned included) or all').choices(STATUS_FILTERS).default('open'))
  .option('--json', 'machine readable output: version 2, the overview')
  .addHelpText(
    'after',
    `
One task in depth is 'yan show <id>'.`,
  )
  .action(
    action('ls', (options: { json?: boolean; status: StatusFilter }) => {
      if (options.json === true) out(JSON.stringify(overview(options.status)));
      else renderQueue(queue(), options.status);
    }),
  );
