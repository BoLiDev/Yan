import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { CommandError } from './shared/errors.js';
import { yanHome } from '../util/home.js';
import { readJson, readJsonIfPresent } from '../util/json.js';
import { Task } from '../records/task/index.js';
import { action, out } from './shared/action.js';
import { dash, renderTable } from './shared/table.js';

/**
 * `yan ls [<id>] [--json]` — the queue, and the deeper view of one task.
 *
 * THIS COMMAND STORES NOTHING. There is no backlog file and there must never be
 * one (td INDEX.md §3): the queue is a view produced by scanning
 * `tasks/*​/task.json` every single time it is asked for. That is design
 * principle 1 — do not store state you can derive — and it removes the most
 * bug-prone thing in the system, a second list that can disagree with the
 * directory.
 *
 * The JSON shape is byte-identical to the shell version's, key order included.
 * That is not cosmetic: during the migration either half may be the one a
 * script is piping into `jq`, and a reordered key is a broken script.
 */

/** jq's `// ""`: null, absent and false become the empty string. */
function orEmpty(value: unknown): unknown {
  return value === null || value === undefined || value === false ? '' : value;
}

/** jq's `unique`: sorted by code point, deduplicated. */
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
 * The live shifts of one task.
 *
 * "Live" means `run/` still exists: `run/` is the only throwaway layer and a
 * shift clocking out deletes it whole (td INDEX.md §3), so its presence IS the
 * fact. A `meta.json` that cannot be parsed is skipped rather than fatal — the
 * file may be half-written at the moment we look (lib-shift invariant 3).
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

export function taskDetailJson(id: string): unknown {
  const task = rawTask(id);
  return {
    version: 1,
    id: orEmpty(task.id),
    title: orEmpty(task.title),
    complete: task.complete === true,
    units: Array.isArray(task.units) ? task.units : [],
    shifts: shiftRows(id),
  };
}

function renderQueue(json: ReturnType<typeof queueJson>): void {
  const data = json as { tasks: Array<Record<string, unknown>> };
  if (data.tasks.length === 0) {
    out(`no tasks in ${join(yanHome(), 'tasks')}`);
    return;
  }
  const rows: string[][] = [['ID', 'STATE', 'UNITS', 'SHIFTS', 'SCOPE', 'TITLE']];
  for (const t of data.tasks) {
    rows.push([
      String(t.id ?? ''),
      t.complete === true ? 'done' : 'open',
      String((t.units as unknown[]).length),
      String(t.shifts),
      dash((t.scope as string[]).join(' ')),
      dash(String(t.title ?? '')),
    ]);
  }
  for (const line of renderTable(rows)) out(line);
}

function renderTask(id: string, json: ReturnType<typeof taskDetailJson>): void {
  const data = json as {
    id: unknown;
    title: unknown;
    complete: boolean;
    units: unknown[];
    shifts: ShiftRow[];
  };
  out(`${String(data.id)}  ${String(data.title)}`);
  out(`state    ${data.complete ? 'done' : 'open'}`);
  out(`dir      ${new Task(id).dir}`);

  out('');
  out('units');
  if (data.units.length === 0) {
    out('  (none)');
  } else {
    const rows: string[][] = [
      ['NAME', 'REPO', 'BRANCH', 'TARGET', 'MODE', 'MR', 'SCOPE', 'NEEDS'],
    ];
    for (const raw of data.units) {
      const u = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
      const list = (v: unknown): string =>
        Array.isArray(v) ? v.map((x) => String(x)).join(' ') : '';
      rows.push([
        dash(u.name === undefined || u.name === null ? '' : String(u.name)),
        dash(u.repo === undefined || u.repo === null ? '' : String(u.repo)),
        dash(u.branch === undefined || u.branch === null ? '' : String(u.branch)),
        dash(u.target === undefined || u.target === null ? '' : String(u.target)),
        dash(u.mode === undefined || u.mode === null ? '' : String(u.mode)),
        dash(u.mr === undefined || u.mr === null ? '' : String(u.mr)),
        dash(list(u.scope)),
        dash(list(u.needs)),
      ]);
    }
    for (const line of renderTable(rows, '  ')) out(line);
  }

  out('');
  out('shifts (live)');
  if (data.shifts.length === 0) {
    out('  (none)');
  } else {
    const rows: string[][] = [['SID', 'UNIT', 'BRANCH', 'TREE']];
    for (const s of data.shifts) {
      rows.push([dash(s.sid), dash(String(s.unit)), dash(String(s.branch)), dash(String(s.tree))]);
    }
    for (const line of renderTable(rows, '  ')) out(line);
  }
}

export const command = new Command('ls')
  .description('the queue, or one task in depth')
  .argument('[task-id]', 'one task: its units, and every live shift')
  .option('--json', 'machine readable output for either form')
  .action(
    action('ls', (id: string | undefined, options: { json?: boolean }) => {
      if (id === undefined) {
        const json = queueJson();
        if (options.json === true) out(JSON.stringify(json));
        else renderQueue(json);
        return;
      }

      if (!Task.exists(id)) {
        const where = Task.isId(id) ? new Task(id).file : `${id}/task.json`;
        throw new CommandError('task', 'missing', `no such task: ${id} - ${where} does not exist`);
      }

      const json = taskDetailJson(id);
      if (options.json === true) out(JSON.stringify(json));
      else renderTask(id, json);
    }),
  );
