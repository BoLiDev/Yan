import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskDir, tasksDir } from '../../util/vault.js';
import { editJson, initJson, readJson } from '../../util/json.js';
import { asRecord, asString } from '../../util/narrow.js';
import { normalizePath } from '../../util/paths.js';
import { YanError } from '../../util/error.js';
import { Log } from '../log/index.js';
import { ENDS, type AddUnitOptions, type HistoryEnd, type HistoryEntry, type TaskData, type UnitData } from './types.js';

/**
 * A handle on one `tasks/<id>/task.json` — which branch a unit is on, where it
 * is meant to go, how far it may reach, and whether the task is finished.
 *
 * It holds identity and nothing else, because other processes write the same
 * file: `read()` goes to disk every time, and every write is one
 * read-modify-write through `util/json.ts`, landing tmp → mv with key order
 * and any field yan does not know about preserved.
 *
 * Three verbs carry everything. `read()` is the whole document; `edit(fn)` and
 * `editUnit(name, fn)` are the writes. The named methods below are the
 * handful of edits that are decisions rather than assignments — creating a
 * unit, rotating a round — plus the reads that had a name worth keeping.
 */
export class Task {
  public readonly id: string;
  public readonly dir: string;
  public readonly file: string;

  /**
   * `dir` and `file` come back with forward slashes on every platform.
   *
   * @throws YanError when `id` is not a valid task id.
   */
  public constructor(id: string) {
    if (!Task.isId(id)) {
      throw YanError.usage('task_usage', `invalid task id: '${id}' - use letters, digits, dot, dash or underscore`);
    }
    this.id = id;
    this.dir = normalizePath(taskDir(id));
    this.file = normalizePath(join(this.dir, 'task.json'));
  }

  public exists(): boolean {
    return existsSync(this.file);
  }

  /**
   * The whole document, with defaults filled in for whatever the file omits or
   * mistypes, so only a missing file throws.
   *
   * @throws YanError `task_missing` when there is no task.json.
   */
  public read(): TaskData {
    const raw = asRecord(readJson(this.require()));
    const units = Array.isArray(raw.units) ? raw.units : [];
    return {
      version: typeof raw.version === 'number' ? raw.version : 1,
      id: asString(raw.id, this.id),
      title: asString(raw.title),
      complete: raw.complete === true,
      abandoned: raw.abandoned === true,
      ...(typeof raw.createdAt === 'string' && raw.createdAt !== '' ? { createdAt: raw.createdAt } : {}),
      ...(typeof raw.closedAt === 'string' && raw.closedAt !== '' ? { closedAt: raw.closedAt } : {}),
      units: units.map((u): UnitData => {
        const r = asRecord(u);
        return {
          name: asString(r.name),
          repo: asString(r.repo),
          scope: asStringArray(r.scope),
          needs: asStringArray(r.needs),
          branch: asString(r.branch),
          target: asString(r.target),
          mr: typeof r.mr === 'string' && r.mr !== '' ? r.mr : null,
          history: Array.isArray(r.history) ? (r.history as HistoryEntry[]) : [],
        };
      }),
    };
  }

  /**
   * Read-modify-write the document, atomically. What `edit` receives is the
   * file as it is on disk, so a field yan has no name for survives the write;
   * anything `edit` throws leaves the file untouched.
   */
  public edit(edit: (task: TaskData) => void): void {
    editJson(this.require(), (current) => {
      const task = asRecord(current);
      edit(task as unknown as TaskData);
      return task;
    });
  }

  /**
   * The same, narrowed to one unit.
   *
   * @throws YanError `task_missing` when no unit of that name exists; it is
   *   never created.
   */
  public editUnit(name: string, edit: (unit: UnitData) => void): void {
    this.edit((task) => {
      const units = Array.isArray(task.units) ? task.units : [];
      const unit = units.find((u) => asRecord(u).name === name);
      if (unit === undefined) throw new YanError('task_missing', `no such unit: ${name}`);
      edit(unit);
    });
  }

  public title(): string {
    return this.read().title;
  }

  public isComplete(): boolean {
    return this.read().complete;
  }

  /** Mark the task done, stamping `closedAt`, or open again, which drops it. */
  public setComplete(complete: boolean): void {
    this.edit((task) => {
      task.complete = complete;
      if (complete) task.closedAt = isoNow();
      else delete task.closedAt;
    });
  }

  /** Mark the task given up on, which also makes it complete: nothing more will happen to it. */
  public setAbandoned(): void {
    this.edit((task) => {
      task.complete = true;
      task.abandoned = true;
      task.closedAt = isoNow();
    });
  }

  /**
   * The name of this task's terminal container: `<id> <title>` with `:` and
   * `.` replaced by `-`, falling back to the id alone when the title cannot be
   * read.
   */
  public containerName(): string {
    let title = '';
    try {
      title = this.title();
    } catch {
      title = '';
    }
    const name = title === '' ? this.id : `${this.id} ${title}`;
    return name.replace(/[:.]/g, '-');
  }

  /** One unit as it is on disk right now, or undefined when the task has none of that name. */
  public findUnit(name: string): UnitData | undefined {
    return this.read().units.find((u) => u.name === name);
  }

  /**
   * As `findUnit`, but throws instead of returning undefined.
   *
   * @throws YanError `task_missing`.
   */
  public unit(name: string): UnitData {
    const found = this.findUnit(name);
    if (found === undefined) throw new YanError('task_missing', `no such unit: ${name}`);
    return found;
  }

  /**
   * Add a unit. `target` is required and never defaulted.
   *
   * @throws YanError when a field is missing or a unit of this name already
   *   exists.
   */
  public addUnit(name: string, repo: string, target: string, options: AddUnitOptions = {}): void {
    if (!name || !repo || !target) {
      throw YanError.usage('task_usage', 'a unit needs a name, a repo and an explicit target');
    }
    this.edit((task) => {
      const units = Array.isArray(task.units) ? task.units : [];
      if (units.some((u) => asRecord(u).name === name)) {
        throw new YanError('task_exists', `unit already exists: ${name}`);
      }
      units.push({
        name,
        repo,
        scope: [...(options.scope ?? [])],
        needs: [...(options.needs ?? [])],
        branch: options.branch ?? '',
        target,
        mr: null,
        history: [],
      });
      task.units = units;
    });
  }

  /**
   * Start a new round of one unit: archive the current branch, target and mr
   * into `history[]` under `end`, then move to `newBranch` and clear mr. One
   * write, so a crash leaves either the old round or the new one.
   *
   * @param at an ISO date, or `''` for today.
   * @throws YanError when `newBranch` is empty or `end` is not one of ENDS.
   */
  public rotateUnit(name: string, end: string, newBranch: string, at = ''): void {
    if (!newBranch) throw YanError.usage('task_usage', 'rotating a unit needs the new branch name');
    this.editUnit(name, (unit) => {
      const entry = historyEntry(
        asString(unit.branch),
        asString(unit.target),
        at,
        end,
        typeof unit.mr === 'string' ? unit.mr : null,
      );
      unit.history = [...(Array.isArray(unit.history) ? unit.history : []), entry];
      unit.branch = newBranch;
      unit.mr = null;
    });
  }

  /** @throws YanError `task_missing` when there is no task.json. */
  private require(): string {
    if (!existsSync(this.file)) {
      throw new YanError('task_missing', `no such task: ${this.id} - expected ${this.file}`);
    }
    return this.file;
  }

  public static isId(id: string): boolean {
    return id !== '' && /^[A-Za-z0-9._-]+$/.test(id);
  }

  /** Does this string name a task? False for a malformed id, never a throw. */
  public static exists(id: string): boolean {
    return Task.isId(id) && new Task(id).exists();
  }

  /**
   * Create task.json, brief.md and an empty log.md. Re-running it on an
   * existing task changes nothing.
   *
   * @throws YanError when `title` is empty.
   */
  public static create(id: string, title: string): Task {
    const task = new Task(id);
    if (title === '') throw YanError.usage('task_usage', 'a task needs a title');

    mkdirSync(task.dir, { recursive: true });
    initJson(task.file, { version: 1, id, title, complete: false, createdAt: isoNow(), units: [] });

    const brief = join(task.dir, 'brief.md');
    if (!existsSync(brief)) writeFileSync(brief, `# ${id} ${title}\n\n`);

    new Log(id).init(title);
    return task;
  }

  /** Every id under `tasks/` that has a task.json, sorted. */
  public static list(): string[] {
    const dir = tasksDir();
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries
      .filter((id) => Task.isId(id) && existsSync(join(dir, id, 'task.json')))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

/** Now, as ISO 8601 UTC to the second: `2026-09-18T14:02:11Z`. */
function isoNow(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function historyEntry(
  branch: string,
  target: string,
  at: string,
  end: string,
  mr: string | null,
): HistoryEntry {
  if (!branch || !target || !end) {
    throw YanError.usage('task_usage', 'a history entry needs at least branch, target and end');
  }
  if (!(ENDS as readonly string[]).includes(end)) {
    throw YanError.usage('task_usage', `invalid end '${end}' - one of: ${ENDS.join(' ')}`);
  }
  const when = at === '' ? new Date().toISOString().slice(0, 10) : at;
  const entry: HistoryEntry = { branch, target, at: when, end: end as HistoryEnd };
  if (mr !== null && mr !== '') entry.mr = mr;
  return entry;
}
