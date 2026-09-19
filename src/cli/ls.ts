import { Command, Option } from 'commander';
import { readJsonIfPresent } from '../util/json.js';
import { Shift } from '../records/shift/index.js';
import { Task } from '../records/task/index.js';
import { action, out } from './shared/action.js';
import { terminalWidth } from './shared/style.js';
import { overview, STATUS_FILTERS, type StatusFilter } from './overview/overview.js';
import { renderOverview } from './overview/render.js';

/**
 * `yan ls [--status open|done|all] [--json]` — the queue, produced by scanning
 * `tasks/*​/task.json` on every call. Stores nothing. One task in depth is
 * `yan show <id>`: two commands printing the same thing is two commands to
 * keep in step.
 *
 * What it prints is the overview in `overview/overview.ts`, as
 * `overview/render.ts` lays it out; `--json` is the same overview, version 2.
 * `queue()` below is the cheap scan the task pickers share.
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

export const command = new Command('ls')
  .description('what you are working on: a card per open task, a line per done one')
  .addOption(new Option('--status <status>', 'which tasks: open, done (abandoned included) or all').choices(STATUS_FILTERS).default('open'))
  .option('--json', 'machine readable output: version 2, the overview')
  .addHelpText(
    'after',
    `
One task in depth is 'yan show <id>'.`,
  )
  .action(
    action('ls', (options: { json?: boolean; status: StatusFilter }) => {
      const now = new Date();
      const found = overview(options.status, { now });
      if (options.json === true) out(JSON.stringify(found));
      else for (const line of renderOverview(found, { now, cols: terminalWidth() })) out(line);
    }),
  );
