import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { tasksDir } from '../util/vault.js';
import { readJson, readJsonIfPresent } from '../util/json.js';
import { Task } from '../records/task/index.js';
import { action, out } from './shared/action.js';
import { dash, renderTable } from './shared/table.js';

/**
 * `yan ls [--json]` — the queue, produced by scanning `tasks/*​/task.json` on
 * every call. Stores nothing. One task in depth is `yan show <id>`: two
 * commands printing the same thing is two commands to keep in step.
 */

/** A string field: null, absent and false all become the empty string. */
function orEmpty(value: unknown): unknown {
  return value === null || value === undefined || value === false ? '' : value;
}

/** Sorted by code point, deduplicated. */
function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

interface ShiftRow {
  sid: string;
  unit: unknown;
  branch: unknown;
  tree: unknown;
  agent: unknown;
}

/**
 * The live shifts of one task — the ones that still have a `run/`. A
 * `meta.json` that cannot be read is skipped rather than fatal.
 */
function shiftRows(id: string): ShiftRow[] {
  const dir = join(new Task(id).dir, 'shifts');
  let sids: string[];
  try {
    sids = readdirSync(dir);
  } catch {
    return [];
  }
  const rows: ShiftRow[] = [];
  for (const sid of sids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const meta = join(dir, sid, 'run', 'meta.json');
    if (!existsSync(meta)) continue;
    let raw: unknown;
    try {
      raw = readJson(meta);
    } catch {
      continue;
    }
    const m = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    rows.push({
      sid,
      unit: orEmpty(m.unit),
      branch: orEmpty(m.branch),
      tree: orEmpty(m.tree),
      agent: orEmpty(m.agent),
    });
  }
  return rows;
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

export function queueJson(): unknown {
  const tasks = Task.list().map((id) => {
    const task = rawTask(id);
    const units = rawUnits(task);
    return {
      id: orEmpty(task.id),
      title: orEmpty(task.title),
      complete: task.complete === true,
      abandoned: task.abandoned === true,
      units: units.map((u) => u.name ?? null),
      scope: unique(
        units.flatMap((u) =>
          Array.isArray(u.scope) ? u.scope.filter((s): s is string => typeof s === 'string') : [],
        ),
      ),
      shifts: shiftRows(id).length,
    };
  });
  return { version: 1, tasks };
}

function renderQueue(json: ReturnType<typeof queueJson>): void {
  const data = json as { tasks: Array<Record<string, unknown>> };
  if (data.tasks.length === 0) {
    out(`no tasks in ${tasksDir()}`);
    return;
  }
  const rows: string[][] = [['ID', 'STATE', 'UNITS', 'SHIFTS', 'SCOPE', 'TITLE']];
  for (const t of data.tasks) {
    rows.push([
      String(t.id ?? ''),
      t.abandoned === true ? 'abandoned' : t.complete === true ? 'done' : 'open',
      String((t.units as unknown[]).length),
      String(t.shifts),
      dash((t.scope as string[]).join(' ')),
      dash(String(t.title ?? '')),
    ]);
  }
  for (const line of renderTable(rows)) out(line);
}

export const command = new Command('ls')
  .description('the queue: every task, one line each')
  .option('--json', 'machine readable output')
  .addHelpText(
    'after',
    `
One task in depth is 'yan show <id>'.`,
  )
  .action(
    action('ls', (options: { json?: boolean }) => {
      const json = queueJson();
      if (options.json === true) out(JSON.stringify(json));
      else renderQueue(json);
    }),
  );
