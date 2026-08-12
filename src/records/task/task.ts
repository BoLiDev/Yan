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
 * One `tasks/<id>/` — the DECISIONS yan has made about a task, and only those.
 *
 * Facts live in git and are never mirrored here; live state is looked up on the
 * forge when it is needed. What is left, and what this file holds, is what
 * neither of them knows: which branch a unit is on, where it is meant to go,
 * how far it may reach, and whether `user` has called the task finished.
 *
 * The state this class holds is IDENTITY — which task — and never the document.
 * Every method re-reads, because other processes write this file while yan is
 * running and a cached parse would be a lie with a long half-life.
 */
export class Task {
  public readonly id: string;
  public readonly dir: string;
  public readonly file: string;

  public constructor(id: string) {
    if (!Task.isId(id)) {
      throw TaskError.usage(`invalid task id: '${id}' - use letters, digits, dot, dash or underscore`);
    }
    this.id = id;
    // Paths yan prints or stores are normalised (conventions §3): forward
    // slashes on both platforms, so `yan ls`'s `dir` line and a `tree` recorded
    // in run/meta.json read the same on Git Bash and on Linux.
    this.dir = normalizePath(taskDir(id));
    this.file = normalizePath(join(this.dir, 'task.json'));
  }

  public exists(): boolean {
    return existsSync(this.file);
  }

  /** The whole document, read leniently. */
  public read(): TaskData {
    return readDocument(this.file, this.id);
  }

  public title(): string {
    return this.read().title;
  }

  public isComplete(): boolean {
    return this.read().complete;
  }

  /**
   * The one thing about a task that cannot be derived: `user` has declared it
   * finished.
   */
  public setComplete(complete: boolean): void {
    editDocument(this.file, this.id, (task) => {
      task.complete = complete;
    });
  }

  /**
   * The name of this task's terminal container.
   *
   * One container per task, and every caller has to reach the
   * SAME one, so the derivation lives here next to the task's other naming. The
   * name is for humans; nothing is ever looked up by it.
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

  /** The same, but a missing unit is an error rather than an absence. */
  public unit(name: string): Unit {
    const found = this.findUnit(name);
    if (found === undefined) throw new TaskError('missing', `no such unit: ${name}`);
    return found;
  }

  /**
   * `target` is required and never defaulted: during a release the team merges
   * into a shared branch, in quiet weeks into the default one, and there is no
   * way to tell which from here. Guessing it wrong aims a merge request at the
   * wrong branch.
   *
   * `mode` defaults to `mr`. A caller that wants the repository's tuned
   * `mode_default` passes it in, because reading mem/repos.json is on the other
   * side of this record's fence.
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
      // Key order is the shell implementation's, so the two halves write the
      // same bytes for the same unit.
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

  /**
   * For an id that has NOT been validated — something a person typed.
   *
   * The constructor refuses a malformed id, which is right when you are about
   * to act on a task and wrong when you are only asking whether a string names
   * one. This answers false instead of throwing.
   */
  public static exists(id: string): boolean {
    return Task.isId(id) && new Task(id).exists();
  }

  /**
   * The minimal task directory: task.json + brief.md + an empty log.md.
   * Re-running it on an existing task changes nothing.
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

  /**
   * Every task id on disk.
   *
   * Derived by scanning, never read from a list. There is no backlog file, and
   * so no second place for a task to exist in but not really.
   */
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
