import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskDir, tasksDir } from '../../util/vault.js';
import { initJson } from '../../util/json.js';
import { normalizePath } from '../../util/paths.js';
import { Log } from '../log/index.js';
import { editDocument, readDocument } from './document.js';
import { TaskError } from './errors.js';
import { Unit } from './unit.js';
import { MODES, type AddUnitOptions, type TaskData } from './types.js';

/**
 * One `tasks/<id>/task.json` — which branch a unit is on, where it is meant to
 * go, how far it may reach, and whether the task is finished. Holds identity
 * only: every method re-reads the file, which other processes also write.
 */
export class Task {
  public readonly id: string;
  public readonly dir: string;
  public readonly file: string;

  /**
   * `dir` and `file` come back with forward slashes on every platform.
   *
   * @throws TaskError when `id` is not a valid task id.
   */
  public constructor(id: string) {
    if (!Task.isId(id)) {
      throw TaskError.usage(`invalid task id: '${id}' - use letters, digits, dot, dash or underscore`);
    }
    this.id = id;
    this.dir = normalizePath(taskDir(id));
    this.file = normalizePath(join(this.dir, 'task.json'));
  }

  public exists(): boolean {
    return existsSync(this.file);
  }

  /** The whole document, with defaults filled in for whatever the file omits. */
  public read(): TaskData {
    return readDocument(this.file, this.id);
  }

  public title(): string {
    return this.read().title;
  }

  public isComplete(): boolean {
    return this.read().complete;
  }

  public setComplete(complete: boolean): void {
    editDocument(this.file, this.id, (task) => {
      task.complete = complete;
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

  public units(): Unit[] {
    return this.read().units.map((u) => new Unit(this.file, this.id, u.name));
  }

  public findUnit(name: string): Unit | undefined {
    return this.read().units.some((u) => u.name === name)
      ? new Unit(this.file, this.id, name)
      : undefined;
  }

  /** As `findUnit`, but throws TaskError `missing` instead of returning undefined. */
  public unit(name: string): Unit {
    const found = this.findUnit(name);
    if (found === undefined) throw new TaskError('missing', `no such unit: ${name}`);
    return found;
  }

  /**
   * Add a unit. `target` is required and never defaulted; `mode` defaults to
   * `mr`, so a caller wanting the repository's `mode_default` passes it in.
   *
   * @throws TaskError when a field is missing, the mode is unknown, or a unit
   *   of this name already exists.
   */
  public addUnit(name: string, repo: string, target: string, options: AddUnitOptions = {}): Unit {
    if (!name || !repo || !target) {
      throw TaskError.usage('a unit needs a name, a repo and an explicit target');
    }
    const mode = options.mode ?? 'mr';
    if (!(MODES as readonly string[]).includes(mode)) {
      throw TaskError.usage(`invalid mode '${mode}' - one of: ${MODES.join(' ')}`);
    }

    editDocument(this.file, this.id, (task) => {
      const units = Array.isArray(task.units) ? task.units : [];
      if (units.some((u) => (u as Record<string, unknown>).name === name)) {
        throw new TaskError('exists', `unit already exists: ${name}`);
      }
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

    return new Unit(this.file, this.id, name);
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
   * @throws TaskError when `title` is empty.
   */
  public static create(id: string, title: string): Task {
    const task = new Task(id);
    if (title === '') throw TaskError.usage('a task needs a title');

    mkdirSync(task.dir, { recursive: true });
    initJson(task.file, { version: 1, id, title, complete: false, units: [] });

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
