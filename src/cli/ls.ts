import { Command, Option } from 'commander';
import { action, out } from './shared/action.js';
import { bold, dim, fit, padEnd, terminalWidth } from './shared/style.js';
import { Log } from '../records/log/index.js';
import { Task, type TaskData, type TaskState } from '../records/task/index.js';
import { localDay } from '../util/time.js';

/**
 * `yan ls [--status open|done|all] [--json]` — one line per task, scanned
 * from `tasks/*​/task.json` on every call. Stores nothing.
 */

const STATUS_FILTERS = ['open', 'done', 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

interface Row {
  readonly id: string;
  readonly title: string;
  /** `null` when task.json cannot be read. */
  readonly state: TaskState | null;
  /** Delivered and counted: an abandoned deliverable counts toward neither. */
  readonly done: number;
  readonly total: number;
  /** The local day anything in the task last changed, `YYYY-MM-DD`. */
  readonly updated: string;
}

/**
 * The local day the task last moved, from what its records say: its last log
 * line, a deliverable delivered, its creation or closing. Never a file's
 * mtime, which a clone or a pull sets to the day it ran.
 *
 * A log line carries no year: it is this year's, or last year's when that
 * would put it in the future.
 */
function updatedOf(task: Task, data: TaskData | undefined, today: Date): string {
  const days: string[] = [];
  const dayOfIso = (iso: string | undefined): void => {
    const d = iso === undefined ? NaN : new Date(iso).getTime();
    if (!Number.isNaN(d)) days.push(localDay(new Date(d)));
  };
  dayOfIso(data?.createdAt);
  dayOfIso(data?.closedAt);
  for (const d of data?.deliverables ?? []) if (d.status === 'done') days.push(d.doneAt);

  const last = new Log(task.id).recall(1).lines.at(-1);
  const md = last === undefined ? null : /^- (\d{2})-(\d{2})/.exec(last);
  if (md !== null) {
    const thisYear = `${today.getFullYear()}-${md[1]}-${md[2]}`;
    days.push(thisYear > localDay(today) ? `${today.getFullYear() - 1}-${md[1]}-${md[2]}` : thisYear);
  }
  return days.sort().at(-1) ?? '';
}

function rowOf(id: string): Row {
  const task = new Task(id);
  let data: TaskData | undefined;
  try {
    data = task.read();
  } catch {
    data = undefined;
  }
  const counted = data?.deliverables.filter((d) => d.status !== 'abandoned') ?? [];
  return {
    id,
    title: data?.title ?? '',
    state: data?.state ?? null,
    done: counted.filter((d) => d.status === 'done').length,
    total: counted.length,
    updated: updatedOf(task, data, new Date()),
  };
}

function wanted(row: Row, status: StatusFilter): boolean {
  if (status === 'all') return true;
  if (status === 'open') return row.state === 'open' || row.state === null;
  return row.state === 'done' || row.state === 'abandoned';
}

/** `10-01` this year, `2025-12-30` before it. */
function shortDay(day: string): string {
  return day.startsWith(`${new Date().getFullYear()}-`) ? day.slice(5) : day;
}

export const command = new Command('ls')
  .description('every task, one line each')
  .addOption(new Option('--status <status>', 'which tasks: open, done (abandoned included) or all').choices(STATUS_FILTERS).default('open'))
  .option('--json', 'the same rows as JSON')
  .action(
    action('yan ls', (options: { status: StatusFilter; json?: boolean }) => {
      const rows = Task.list().map(rowOf).filter((r) => wanted(r, options.status));
      if (options.json === true) {
        out(JSON.stringify(rows));
        return;
      }
      if (rows.length === 0) {
        out(options.status === 'open' ? "no open tasks - 'yan' starts one, 'yan ls --status all' lists the closed ones" : 'no tasks');
        return;
      }
      const idWidth = Math.max(...rows.map((r) => r.id.length));
      const dayWidth = Math.max(...rows.map((r) => shortDay(r.updated).length));
      const cols = terminalWidth();
      for (const r of rows) {
        const progress = r.total === 0 ? '-' : `${r.done}/${r.total}`;
        const head = `${padEnd(r.id, idWidth)}  ${padEnd(r.state ?? 'unreadable', 10)} ${progress.padStart(5)}  ${padEnd(shortDay(r.updated), dayWidth)}  `;
        const title = cols === undefined ? r.title : fit(r.title, Math.max(10, cols - head.length - 1));
        out(r.state === 'open' ? `${bold(padEnd(r.id, idWidth))}${head.slice(idWidth)}${title}` : dim(`${head}${title}`));
      }
    }),
  );
