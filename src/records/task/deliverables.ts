import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { taskDir } from '../../util/vault.js';
import { initJson, readJson, writeJson } from '../../util/json.js';
import { recordOrNone } from '../../util/narrow.js';
import { normalizePath } from '../../util/paths.js';
import { YanError } from '../../util/error.js';

/**
 * `tasks/<id>/deliverable.json` — what a task has to build to solve the
 * problems its brief states. An attribute of the task, known from its first
 * session and revised as the work goes on, never a summary of its log:
 * `brief.md` says what the trouble is, this says what fixes it.
 *
 * Written only by `yan deliverable …`, so every mark has a command behind it
 * and the file's shape is never a matter of how somebody typed a bullet.
 * Read by `yan session-start`, `yan show`, `yan mr` and the work report.
 */

/** `<task dir>/deliverable.json`. Written only by `yan deliverable …`. */
export interface DeliverableFile {
  readonly version: 1;
  /**
   * One more than the highest id ever used. Kept in the file so `rm` cannot
   * make the next `add` reuse an id somebody has already quoted.
   */
  readonly nextId: number;
  /** File order is page order: the writer's, not time's. */
  readonly deliverables: readonly Deliverable[];
}

export type Deliverable = Todo | Done | Abandoned;

interface Base {
  /** `d1`, `d2`…: stable inside the task, survives a rewording, never reused. */
  readonly id: string;
  /** The outcome, in a sentence or two an outside reader follows. No process, no verification. */
  readonly text: string;
}
export interface Todo extends Base { readonly status: 'todo' }
export interface Done extends Base {
  readonly status: 'done';
  /** Local `YYYY-MM-DD`. */
  readonly doneAt: string;
  /** What proves it, `PR #58`; several or none. */
  readonly refs?: readonly string[];
}
export interface Abandoned extends Base {
  readonly status: 'abandoned';
  /** Required. */
  readonly reason: string;
}

export const DELIVERABLE_STATUSES = ['todo', 'done', 'abandoned'] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

/** An empty file: a task that has not been broken down yet. */
const EMPTY: DeliverableFile = { version: 1, nextId: 1, deliverables: [] };

/** The file name, relative to a task directory. */
export const DELIVERABLE_FILE = 'deliverable.json';

/**
 * What a reader that must not fail gets: the deliverables, and the reason the
 * file could not be read when there is one. A task whose file is broken is a
 * task with no deliverables and a problem to report — never a throw, because
 * the work report covers every task and one bad file cannot take the rest
 * down with it.
 */
export interface DeliverablesRead {
  /** Empty when the file is missing or does not validate. */
  readonly deliverables: readonly Deliverable[];
  /** What is wrong with the file, as a sentence naming it; null when it is fine. */
  readonly problem: string | null;
}

/**
 * One task's deliverable.json. Every write is a whole-file replacement
 * through `util/json.ts`, so a reader never sees half of one, and every write
 * reads first: two processes writing the same task at once is not a case this
 * has, because only the main agent runs `yan deliverable`.
 */
export class Deliverables {
  public readonly id: string;

  /** Absolute path, whether or not the file exists yet. */
  public readonly file: string;

  /** @throws YanError `deliverable_usage` when `taskId` is empty. */
  public constructor(taskId: string) {
    if (!taskId) throw YanError.usage('deliverable_usage', 'a task id is required');
    this.id = taskId;
    this.file = normalizePath(join(taskDir(taskId), DELIVERABLE_FILE));
  }

  public exists(): boolean {
    return existsSync(this.file);
  }

  /** Create an empty file when there is none. An existing one is left exactly as it is. */
  public init(): void {
    initJson(this.file, EMPTY);
  }

  /**
   * The whole file. A missing one reads as an empty list rather than an
   * error: a task created before this existed simply has no deliverables yet.
   *
   * @throws YanError `deliverable_invalid` when the file is there and does not
   *   validate. The message names the file and what is wrong with it.
   */
  public read(): DeliverableFile {
    if (!existsSync(this.file)) return EMPTY;
    let raw: unknown;
    try {
      raw = readJson(this.file);
    } catch (err) {
      throw new YanError('deliverable_invalid', `${this.file} is not valid JSON`, { cause: err });
    }
    return validate(raw, this.file);
  }

  /**
   * The same read, with the refusal handed back rather than thrown. This is
   * what a reader that covers every task calls.
   */
  public readOrNone(): DeliverablesRead {
    try {
      return { deliverables: this.read().deliverables, problem: null };
    } catch (err) {
      return { deliverables: [], problem: err instanceof Error ? err.message : String(err) };
    }
  }

  /** One deliverable by id, or undefined. */
  public find(id: string): Deliverable | undefined {
    return this.read().deliverables.find((d) => d.id === id);
  }

  /**
   * Append one deliverable per text, in the order given, and return the ones
   * written.
   *
   * @throws YanError `deliverable_usage` when no text was given or one of them
   *   is empty, `deliverable_invalid` when the file does not validate.
   */
  public add(texts: readonly string[]): readonly Deliverable[] {
    const cleaned = texts.map((t) => oneLine('add', t));
    if (cleaned.length === 0) throw YanError.usage('deliverable_usage', 'nothing to add - pass the text of at least one deliverable');

    const current = this.read();
    let next = current.nextId;
    const added: Deliverable[] = [];
    for (const text of cleaned) {
      added.push({ id: `d${next}`, text, status: 'todo' });
      next += 1;
    }
    this.write({ ...current, nextId: next, deliverables: [...current.deliverables, ...added] });
    return added;
  }

  /**
   * Reword one, keeping its id, status and everything else.
   *
   * @throws YanError `deliverable_usage` for an empty text or an unknown id.
   */
  public set(id: string, text: string): Deliverable {
    const cleaned = oneLine('set', text);
    return this.replace(id, (d) => ({ ...d, text: cleaned }));
  }

  /**
   * Mark one delivered. `at` is a local `YYYY-MM-DD`, today when empty.
   *
   * @throws YanError `deliverable_usage` for an unknown id or a date that is
   *   not a real `YYYY-MM-DD`.
   */
  public done(id: string, at: string, refs: readonly string[]): Done {
    const doneAt = at === '' ? today() : at;
    if (!isDate(doneAt)) {
      throw YanError.usage('deliverable_usage', `--at takes a real date as YYYY-MM-DD, not '${at}'`);
    }
    const kept = refs.map((r) => oneLine('done', r));
    return this.replace(id, (d) => ({
      id: d.id,
      text: d.text,
      status: 'done',
      doneAt,
      ...(kept.length > 0 ? { refs: kept } : {}),
    })) as Done;
  }

  /**
   * Give one up, with the reason it is not being done.
   *
   * @throws YanError `deliverable_usage` for an unknown id or an empty reason.
   */
  public abandon(id: string, reason: string): Abandoned {
    const why = oneLine('abandon', reason);
    return this.replace(id, (d) => ({ id: d.id, text: d.text, status: 'abandoned', reason: why })) as Abandoned;
  }

  /**
   * Back to to-do, dropping the date, the refs and the reason.
   *
   * @throws YanError `deliverable_usage` for an unknown id.
   */
  public todo(id: string): Todo {
    return this.replace(id, (d) => ({ id: d.id, text: d.text, status: 'todo' })) as Todo;
  }

  /**
   * Remove one entirely, for a deliverable added by mistake. `nextId` does not
   * move, so the id it had is never handed out again.
   *
   * @throws YanError `deliverable_usage` for an unknown id.
   */
  public rm(id: string): Deliverable {
    const current = this.read();
    const gone = this.require(current, id);
    this.write({ ...current, deliverables: current.deliverables.filter((d) => d.id !== id) });
    return gone;
  }

  /** Replace one deliverable in place, keeping file order. */
  private replace(id: string, edit: (d: Deliverable) => Deliverable): Deliverable {
    const current = this.read();
    this.require(current, id);
    let written: Deliverable | undefined;
    const deliverables = current.deliverables.map((d) => {
      if (d.id !== id) return d;
      written = edit(d);
      return written;
    });
    this.write({ ...current, deliverables });
    return written as Deliverable;
  }

  /** @throws YanError `deliverable_usage` naming the ids there are. */
  private require(file: DeliverableFile, id: string): Deliverable {
    const found = file.deliverables.find((d) => d.id === id);
    if (found !== undefined) return found;
    const ids = file.deliverables.map((d) => d.id);
    throw YanError.usage('deliverable_usage',
      `no such deliverable: ${id} - ${ids.length === 0 ? 'this task has none yet' : `this task has ${ids.join(' ')}`}`,
    );
  }

  private write(file: DeliverableFile): void {
    writeJson(this.file, { version: 1, nextId: file.nextId, deliverables: file.deliverables });
  }
}

/**
 * A task's deliverables without a throw anywhere in the path, for a reader
 * that covers every task: the work report, and `yan ls`. A task id that is
 * not a task, a vault that cannot be resolved and a file that does not
 * validate all come back as an empty list with a problem.
 */
export function readDeliverables(taskId: string): DeliverablesRead {
  try {
    return new Deliverables(taskId).readOrNone();
  } catch (err) {
    return { deliverables: [], problem: err instanceof Error ? err.message : String(err) };
  }
}

/** What the file says a deliverable is done or given up for, as one short string; `''` for a to-do. */
export function deliverableAside(d: Deliverable): string {
  if (d.status === 'done') return [d.doneAt, ...(d.refs ?? [])].join(' · ');
  if (d.status === 'abandoned') return d.reason;
  return '';
}

/** Today, as a local `YYYY-MM-DD`. */
export function today(now = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** `YYYY-MM-DD`, and a day that exists: `2026-02-30` is not one. */
export function isDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(y, mo, 0).getDate();
}

/**
 * One line of text, trimmed.
 *
 * @throws YanError `deliverable_usage` when it is empty or spans lines: a
 *   deliverable is a sentence or two, and each write puts it in one log line.
 */
function oneLine(what: string, text: string): string {
  const cleaned = (text ?? '').trim();
  if (cleaned === '') throw YanError.usage('deliverable_usage', `${what}: the text is required and cannot be blank`);
  if (/[\r\n]/.test(cleaned)) {
    throw YanError.usage('deliverable_usage', `${what}: a deliverable is one line - it is a sentence or two, and it goes into one log entry`);
  }
  return cleaned;
}

/**
 * The parsed file, or a refusal naming it and the first thing wrong with it.
 * Nothing is repaired and nothing is defaulted away: a file yan does not
 * understand is one a person has to look at, because it is the only record of
 * what the task set out to build.
 *
 * @throws YanError `deliverable_invalid`.
 */
function validate(raw: unknown, file: string): DeliverableFile {
  const refuse = (why: string): never => {
    throw new YanError('deliverable_invalid', `${file} is not a deliverable record: ${why}`);
  };

  const doc = recordOrNone(raw);
  if (doc === undefined) return refuse('the top level is not an object');
  if (doc.version !== 1) {
    return refuse(`version is ${JSON.stringify(doc.version)}, and this build writes version 1`);
  }
  if (!Array.isArray(doc.deliverables)) return refuse('"deliverables" is missing or is not an array');

  const seen = new Set<string>();
  const deliverables: Deliverable[] = [];
  for (const [i, entry] of doc.deliverables.entries()) {
    const at = `deliverables[${i}]`;
    const d = recordOrNone(entry);
    if (d === undefined) return refuse(`${at} is not an object`);

    const id = d.id;
    if (typeof id !== 'string' || id === '') return refuse(`${at} has no id`);
    if (seen.has(id)) return refuse(`two deliverables share the id ${id}`);
    seen.add(id);

    const text = d.text;
    if (typeof text !== 'string' || text.trim() === '') return refuse(`${id} has no text`);

    const status = d.status;
    if (typeof status !== 'string' || !(DELIVERABLE_STATUSES as readonly string[]).includes(status)) {
      return refuse(`${id} has status ${JSON.stringify(status)} - one of: ${DELIVERABLE_STATUSES.join(' ')}`);
    }

    if (status === 'todo') {
      deliverables.push({ id, text, status: 'todo' });
      continue;
    }
    if (status === 'done') {
      const doneAt = d.doneAt;
      if (typeof doneAt !== 'string' || !isDate(doneAt)) {
        return refuse(`${id} is done but its doneAt is ${JSON.stringify(doneAt)} - a local YYYY-MM-DD`);
      }
      if (d.refs !== undefined && (!Array.isArray(d.refs) || d.refs.some((r) => typeof r !== 'string' || r === ''))) {
        return refuse(`${id} has refs that are not a list of strings`);
      }
      const refs = (d.refs ?? []) as readonly string[];
      deliverables.push({ id, text, status: 'done', doneAt, ...(refs.length > 0 ? { refs } : {}) });
      continue;
    }
    const reason = d.reason;
    if (typeof reason !== 'string' || reason.trim() === '') {
      return refuse(`${id} is abandoned and gives no reason, which is the one thing an abandoned deliverable has to say`);
    }
    deliverables.push({ id, text, status: 'abandoned', reason });
  }

  // Absent on a file written before the field, or by hand: derived rather
  // than refused, because the ids themselves say what has been used.
  const stated = doc.nextId;
  const highest = Math.max(0, ...deliverables.map((d) => Number(/^d(\d+)$/.exec(d.id)?.[1] ?? 0)));
  const nextId =
    typeof stated === 'number' && Number.isInteger(stated) && stated > highest ? stated : highest + 1;

  return { version: 1, nextId, deliverables };
}
