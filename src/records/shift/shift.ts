import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';
import { tasksDir } from '../../util/vault.js';
import { normalizePath } from '../../util/paths.js';
import { Task } from '../task/index.js';
import { ShiftError } from './errors.js';
import { readMeta } from './meta.js';
import { appendEvent, countEvents, reportedMr } from './status.js';
import type { ShiftMeta } from './types.js';

/**
 * One `tasks/<id>/shifts/<sid>/` and its throwaway `run/` directory. Holds
 * identity only; every reader below hits the disk on each call, because the
 * shift writes `run/` while yan reads it.
 */
export class Shift {
  public readonly task: string;
  public readonly sid: string;
  public readonly dir: string;
  public readonly run: string;

  /**
   * @param task the task id, or '' when it is unknown.
   * @param dir overrides the standard `<task>/shifts/<sid>` location.
   * @throws ShiftError when `sid` is not a valid id.
   */
  public constructor(task: string, sid: string, dir?: string) {
    if (!Shift.isId(sid)) {
      throw ShiftError.usage(
        `invalid shift id: '${sid}' - use letters, digits, dot, dash or underscore`,
      );
    }
    this.task = task;
    this.sid = sid;
    this.dir = dir ?? normalizePath(join(new Task(task).dir, 'shifts', sid));
    this.run = normalizePath(join(this.dir, 'run'));
  }

  /** How this shift is named in a message. */
  public label(): string {
    return this.task === '' ? this.sid : `${this.sid} (task ${this.task})`;
  }

  /** True while `run/` still exists, which clocking out deletes. */
  public isLive(): boolean {
    return existsSync(this.run);
  }

  /** `run/meta.json`, read once, every field optional. */
  public meta(): ShiftMeta {
    return readMeta(this.run);
  }

  /** How many events have been reported. */
  public eventCount(): number {
    return countEvents(this.run);
  }

  /** The merge request URL this shift reported, if any. */
  public reportedMr(): string | undefined {
    return reportedMr(this.run);
  }

  /** Append one event and touch the wake marker. */
  public appendEvent(state: string, note = ''): void {
    appendEvent(this.run, state, note);
  }

  public static isId(sid: string): boolean {
    return sid !== '' && /^[A-Za-z0-9._-]+$/.test(sid);
  }

  /**
   * Find an existing shift by id, scanning `tasks/*​/shifts/<sid>`.
   *
   * @param task narrows the search; defaults to `$YAN_TASK`.
   * @throws ShiftError `missing` when nothing matches, `ambiguous` when the id
   *   exists under more than one task and no task was named.
   */
  public static resolve(sid: string, task = ''): Shift {
    if (!Shift.isId(sid)) {
      throw ShiftError.usage(
        `invalid shift id: '${sid}' - use letters, digits, dot, dash or underscore`,
      );
    }
    const want = task !== '' ? task : (process.env.YAN_TASK ?? '');

    if (want !== '') {
      const shift = new Shift(want, sid);
      if (!existsSync(shift.dir)) {
        throw new ShiftError(
          'missing',
          `no such shift: ${sid} in task ${want} - ${shift.dir} does not exist`,
        );
      }
      return shift;
    }

    const dir = tasksDir();
    let ids: string[];
    try {
      ids = readdirSync(dir);
    } catch {
      ids = [];
    }
    const hits = ids.filter((id) => existsSync(join(dir, id, 'shifts', sid)));

    if (hits.length === 0) {
      throw new ShiftError(
        'missing',
        `no such shift: ${sid} - nothing matches ${dir}/*/shifts/${sid}`,
      );
    }
    if (hits.length > 1) {
      throw new ShiftError(
        'ambiguous',
        `shift id '${sid}' exists in more than one task - name the task, for example --task <id>\n${hits
          .map((h) => `  ${h}`)
          .join('\n')}`,
      );
    }
    return new Shift(hits[0] as string, sid);
  }

  /**
   * Point at a shift given its directory. The task id is recovered only from a
   * `…/<task>/shifts/<sid>` path and is `''` otherwise.
   *
   * @throws ShiftError when `dir` is empty or does not exist.
   */
  public static fromDir(dir: string): Shift {
    if (!dir) throw ShiftError.usage('a shift directory is required');
    if (!existsSync(dir)) throw new ShiftError('missing', `no such directory: ${dir}`);
    const abs = normalizePath(resolvePath(dir));
    const parent = dirname(abs);
    const task = basename(parent) === 'shifts' ? basename(dirname(parent)) : '';
    return new Shift(task, basename(abs), abs);
  }

  /**
   * The calling shift, named by the environment its spawn script set, or
   * undefined when none of these say:
   *
   *   YAN_SHIFT_DIR        the shift's own directory (preferred)
   *   YAN_TASK_DIR         the shift's own directory, or the task directory
   *                        when YAN_SID is also set
   *   YAN_TASK + YAN_SID   ids only; resolved by scanning
   */
  public static fromEnv(): Shift | undefined {
    const shiftDir = process.env.YAN_SHIFT_DIR;
    if (shiftDir) return Shift.fromDir(shiftDir);

    const taskDirEnv = process.env.YAN_TASK_DIR;
    const sid = process.env.YAN_SID;
    if (taskDirEnv) {
      const trimmed = taskDirEnv.replace(/[\\/]+$/, '');
      if (existsSync(join(trimmed, 'run')) || basename(dirname(trimmed)) === 'shifts') {
        return Shift.fromDir(trimmed);
      }
      if (sid && existsSync(join(trimmed, 'shifts', sid))) {
        return Shift.fromDir(join(trimmed, 'shifts', sid));
      }
    }
    if (sid) return Shift.resolve(sid, process.env.YAN_TASK ?? '');
    return undefined;
  }

  /** Every shift of a task that still has `run/meta.json`, in id order. */
  public static liveIn(task: string): Shift[] {
    const dir = join(new Task(task).dir, 'shifts');
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries
      .filter((sid) => Shift.isId(sid) && existsSync(join(dir, sid, 'run', 'meta.json')))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((sid) => new Shift(task, sid));
  }
}
