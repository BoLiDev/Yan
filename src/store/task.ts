import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { YanError, type YanErrorOptions } from '../util/error.js';
import { yanHome } from '../util/home.js';
import { editJson, initJson, readJson } from '../util/json.js';
import { normalizePath } from '../util/paths.js';
import { Log } from '../records/log/index.js';

/**
 * Reading and writing `tasks/<id>/task.json`. The TypeScript half of
 * `bin/lib-task.sh` (architecture.md §4.2).
 *
 * Thin on purpose. Like `log.ts` it is not hiding complexity; it exists so that
 * a handful of invariants have exactly one enforcement point instead of being
 * re-implemented at twenty call sites.
 *
 *   1. `history[]` is APPEND-ONLY. Once an entry is written it is never
 *      modified and never removed. The API is the enforcement: the only history
 *      writer builds `old + [entry]`, and no function here takes a history
 *      index.
 *
 *   2. The four current scalars — branch / target / mode / mr — are fields of
 *      the unit, SEPARATE from the history. "Current is the last element of
 *      history[]" is explicitly rejected by branching.md §6.4.
 *
 *   3. A history entry has at most five fields — branch, target, at, end and an
 *      optional mr — and `end` is only ever `delivered` or `abandoned`.
 *
 *   4. One completion flag per task, because "user has declared this task
 *      finished" is the single thing about a task that cannot be derived.
 *
 *   5. Every write goes through `util/json.ts`, so it lands tmp → mv and
 *      carries a version field. This module never writes a .json itself.
 *
 * Key order is preserved on every edit rather than rebuilt, so a task.json
 * written by this half is byte-identical to one written by the shell half. That
 * is what makes a bash `yan shift new` and a TypeScript `yan ls` agree about
 * the same file (plan/INDEX.md §2).
 */

export const MODES = ['scout', 'branch', 'mr'] as const;
export type Mode = (typeof MODES)[number];

export const ENDS = ['delivered', 'abandoned'] as const;
export type HistoryEnd = (typeof ENDS)[number];

export interface HistoryEntry {
  branch: string;
  target: string;
  at: string;
  end: HistoryEnd;
  mr?: string;
}

export interface Unit {
  name: string;
  repo: string;
  scope: string[];
  needs: string[];
  branch: string;
  target: string;
  mode: Mode;
  mr: string | null;
  history: HistoryEntry[];
  [key: string]: unknown;
}

export interface Task {
  version: number;
  id: string;
  title: string;
  complete: boolean;
  units: Unit[];
  [key: string]: unknown;
}

const CODES = {
  usage: 'task_usage',
  missing: 'task_missing',
  exists: 'task_exists',
} as const;

export type TaskErrorKind = keyof typeof CODES;

/** What reading or writing a task can fail with. */
export class TaskError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: TaskErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  /** The caller passed something impossible. Exit 2. */
  public static usage(message: string): TaskError {
    return new TaskError('usage', message, { exitCode: 2 });
  }
}

function home(): string {
  return yanHome();
}

export function isTaskId(id: string): boolean {
  return id !== '' && /^[A-Za-z0-9._-]+$/.test(id);
}

function requireId(id: string): string {
  if (!isTaskId(id)) {
    throw TaskError.usage(`invalid task id: '${id}' - use letters, digits, dot, dash or underscore`,
    );
  }
  return id;
}

// --- paths -----------------------------------------------------------------

/**
 * Paths yan prints or stores are normalised (conventions §3): forward slashes
 * on both platforms, so `yan ls`'s `dir` line and a `tree` recorded in
 * run/meta.json read the same on Git Bash and on Linux. Node accepts this
 * spelling for every filesystem call, so nothing has to convert it back.
 */
export function taskDir(id: string): string {
  return normalizePath(join(home(), 'tasks', requireId(id)));
}

export function taskFile(id: string): string {
  return normalizePath(join(taskDir(id), 'task.json'));
}

export function taskExists(id: string): boolean {
  if (!isTaskId(id)) return false;
  return existsSync(taskFile(id));
}

function requireTaskFile(id: string): string {
  const f = taskFile(id);
  if (!existsSync(f)) {
    throw new TaskError('missing', `no such task: ${id} - expected ${f}`);
  }
  return f;
}

// --- reading ----------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * The task, read leniently.
 *
 * A missing key, an unexpected key or a half-written array must never crash a
 * reader — that is the same defensive rule `lib-shift.sh` states for
 * `run/meta.json`, and it applies here for the same reason: this file is
 * written by two implementations during the migration and read by everything.
 */
export function readTask(id: string): Task {
  const raw = asRecord(readJson(requireTaskFile(id)));
  const units = Array.isArray(raw.units) ? raw.units : [];
  return {
    ...raw,
    version: typeof raw.version === 'number' ? raw.version : 1,
    id: asString(raw.id, id),
    title: asString(raw.title),
    complete: raw.complete === true,
    units: units.map((u): Unit => {
      const r = asRecord(u);
      const mode = asString(r.mode, 'mr');
      return {
        ...r,
        name: asString(r.name),
        repo: asString(r.repo),
        scope: asStringArray(r.scope),
        needs: asStringArray(r.needs),
        branch: asString(r.branch),
        target: asString(r.target),
        mode: (MODES as readonly string[]).includes(mode) ? (mode as Mode) : 'mr',
        mr: typeof r.mr === 'string' && r.mr !== '' ? r.mr : null,
        history: Array.isArray(r.history) ? (r.history as HistoryEntry[]) : [],
      };
    }),
  };
}

/**
 * Every task id on disk, one per line's worth.
 *
 * Derived by scanning, never read from a list: there is no backlog file
 * (td INDEX.md §3).
 */
export function taskList(): string[] {
  const dir = join(home(), 'tasks');
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((id) => isTaskId(id) && existsSync(join(dir, id, 'task.json')))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function taskTitle(id: string): string {
  return readTask(id).title;
}

export function taskIsComplete(id: string): boolean {
  return readTask(id).complete;
}

export function findUnit(task: Task, name: string): Unit | undefined {
  return task.units.find((u) => u.name === name);
}

export function requireUnit(task: Task, name: string): Unit {
  const u = findUnit(task, name);
  if (u === undefined) throw new TaskError('missing', `no such unit: ${name}`);
  return u;
}

/**
 * The name of this task's terminal container.
 *
 * One container per task (agents.md §5.7), and every caller has to reach the
 * SAME one, so the derivation lives here next to the task's other naming. The
 * name is for humans; nothing is ever looked up by it.
 */
export function taskContainerName(id: string): string {
  requireId(id);
  let title = '';
  try {
    title = taskTitle(id);
  } catch {
    title = '';
  }
  const name = title === '' ? id : `${id} ${title}`;
  return name.replace(/[:.]/g, '-');
}

// --- creation ---------------------------------------------------------------

/**
 * The minimal task directory: task.json + brief.md + an empty log.md.
 * Re-running it on an existing task changes nothing.
 */
export function taskInit(id: string, title: string): void {
  requireId(id);
  if (title === '') throw TaskError.usage('a task needs a title');

  const dir = taskDir(id);
  mkdirSync(dir, { recursive: true });

  initJson(join(dir, 'task.json'), {
    version: 1,
    id,
    title,
    complete: false,
    units: [],
  });

  const brief = join(dir, 'brief.md');
  if (!existsSync(brief)) writeFileSync(brief, `# ${id} ${title}\n\n`);

  new Log(id).init(title);
}

// --- writing ----------------------------------------------------------------

/** Read-modify-write one task.json, atomically, preserving key order. */
function editTask(id: string, edit: (task: Record<string, unknown>) => void): void {
  const file = requireTaskFile(id);
  editJson(file, (current) => {
    const task = asRecord(current);
    edit(task);
    return task;
  });
}

function editUnit(id: string, unitName: string, edit: (unit: Record<string, unknown>) => void): void {
  editTask(id, (task) => {
    const units = Array.isArray(task.units) ? task.units : [];
    const unit = units.map(asRecord).find((u) => u.name === unitName);
    if (unit === undefined) throw new TaskError('missing', `no such unit: ${unitName}`);
    edit(unit);
  });
}

export function setComplete(id: string, complete: boolean): void {
  editTask(id, (task) => {
    task.complete = complete;
  });
}

export interface UnitAddOptions {
  readonly branch?: string;
  readonly mode?: string;
  readonly scope?: readonly string[];
  readonly needs?: readonly string[];
}

/**
 * `target` is required and never defaulted, because branching.md §6.4 says
 * there is no safe default for it. `mode` defaults to `mr` (delivery.md §8.2);
 * a caller that wants the repository's tuned `mode_default` passes it, since
 * reading mem/repos.json is `yan repo-add`'s side of the fence.
 */
export function unitAdd(
  id: string,
  name: string,
  repo: string,
  target: string,
  options: UnitAddOptions = {},
): void {
  if (!name || !repo || !target) {
    throw TaskError.usage('a unit needs a name, a repo and an explicit target');
  }
  const mode = options.mode ?? 'mr';
  if (!(MODES as readonly string[]).includes(mode)) {
    throw TaskError.usage(`invalid mode '${mode}' - one of: ${MODES.join(' ')}`);
  }

  editTask(id, (task) => {
    const units = Array.isArray(task.units) ? task.units : [];
    if (units.map(asRecord).some((u) => u.name === name)) {
      throw new TaskError('exists', `unit already exists: ${name}`);
    }
    // Key order is the shell implementation's, so the two halves write the same
    // bytes for the same unit.
    units.push({
      name,
      repo,
      scope: [...(options.scope ?? [])],
      needs: [...(options.needs ?? [])],
      branch: options.branch ?? '',
      target,
      mode,
      mr: null,
      history: [],
    });
    task.units = units;
  });
}

export type ScalarField = 'branch' | 'target' | 'mode' | 'mr';

/** The ONLY writer of the four current scalars. It never touches history[]. */
export function unitSet(id: string, unitName: string, field: ScalarField, value: string): void {
  if (field === 'mode' && !(MODES as readonly string[]).includes(value)) {
    throw TaskError.usage(`invalid mode '${value}' - one of: ${MODES.join(' ')}`);
  }
  editUnit(id, unitName, (unit) => {
    unit[field] = value;
  });
}

export function unitSetScope(id: string, unitName: string, scope: readonly string[]): void {
  editUnit(id, unitName, (unit) => {
    unit.scope = [...scope];
  });
}

export function unitSetNeeds(id: string, unitName: string, needs: readonly string[]): void {
  editUnit(id, unitName, (unit) => {
    unit.needs = [...needs];
  });
}

// --- history: append, and nothing else -------------------------------------

/**
 * branching.md §6.5: the built-in integration branch name carries r<n> where n
 * is length(history) + 1, so the round number needs no storage.
 */
export function unitRounds(id: string, unitName: string): number {
  return requireUnit(readTask(id), unitName).history.length;
}

function buildHistoryEntry(
  branch: string,
  target: string,
  at: string,
  end: string,
  mr?: string | null,
): HistoryEntry {
  if (!branch || !target || !end) {
    throw TaskError.usage('a history entry needs at least branch, target and end');
  }
  if (!(ENDS as readonly string[]).includes(end)) {
    throw TaskError.usage(`invalid end '${end}' - one of: ${ENDS.join(' ')}`);
  }
  const when = at === '' ? new Date().toISOString().slice(0, 10) : at;
  // Exactly the five fields of branching.md §6.4, and `mr` only when there is
  // one: an abandoned round may never have opened an MR at all.
  const entry: HistoryEntry = { branch, target, at: when, end: end as HistoryEnd };
  if (mr !== undefined && mr !== null && mr !== '') entry.mr = mr;
  return entry;
}

/**
 * The only history writer in the code base. It builds `history + [entry]`, so
 * every existing entry is carried across untouched by construction. Pass an
 * empty string for `at` to mean today.
 */
export function historyAppend(
  id: string,
  unitName: string,
  branch: string,
  target: string,
  at: string,
  end: string,
  mr?: string | null,
): void {
  const entry = buildHistoryEntry(branch, target, at, end, mr);
  editUnit(id, unitName, (unit) => {
    const history = Array.isArray(unit.history) ? unit.history : [];
    unit.history = [...history, entry];
  });
}

/**
 * Starting a new round is ONE atomic operation (architecture.md §5.1): archive
 * the current branch/target/mr into history[] with `at`, then overwrite the
 * current branch and clear mr — in a single tmp → mv. Deciding `end` is
 * `yan unit set`'s business, not storage's.
 */
export function unitRotate(
  id: string,
  unitName: string,
  end: string,
  newBranch: string,
  at = '',
): void {
  if (!newBranch) {
    throw TaskError.usage('rotating a unit needs the new branch name');
  }
  editUnit(id, unitName, (unit) => {
    const entry = buildHistoryEntry(
      asString(unit.branch),
      asString(unit.target),
      at,
      end,
      typeof unit.mr === 'string' ? unit.mr : null,
    );
    const history = Array.isArray(unit.history) ? unit.history : [];
    unit.history = [...history, entry];
    unit.branch = newBranch;
    unit.mr = null;
  });
}
