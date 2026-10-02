import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { taskDir, tasksDir } from '../../util/vault.js';
import { editJson, initJson, readJson } from '../../util/json.js';
import { recordOrNone } from '../../util/narrow.js';
import { normalizePath } from '../../util/paths.js';
import { YanError } from '../../util/error.js';
import { isDate, isoSecond, localDay } from '../../util/time.js';
import { byCodePoint, isRecordId, nextNumbered } from '../../util/names.js';
import { TASK_STATES, type Deliverable, type TaskData, type TaskState } from './types.js';

/**
 * A handle on one `tasks/<id>/task.json`: what the task is called, whether it
 * is finished, which repository its tree is cut from, and the deliverables it
 * is measured against.
 *
 * It holds identity and nothing else: `read()` goes to disk every time, and
 * every write is one read-modify-write through `util/json.ts`, landing tmp →
 * rename with any field yan does not know about preserved.
 */
export class Task {
  public readonly id: string;
  public readonly dir: string;
  public readonly file: string;

  /** @throws YanError when `id` is not a valid task id. */
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

  /** `brief.md`, whether or not it exists. */
  public get brief(): string {
    return normalizePath(join(this.dir, 'brief.md'));
  }

  /**
   * The whole document. Fields a hand edit dropped come back as defaults; a
   * deliverable list yan cannot read throws, because it is the only record of
   * what the task set out to build and guessing would rewrite it.
   *
   * @throws YanError `task_missing` when there is no task.json,
   *   `task_invalid` when it does not validate.
   */
  public read(): TaskData {
    return validate(readJson(this.require()), this);
  }

  /**
   * Close the task: `done`, or `abandoned` with the reason it was given up.
   * Stamps `closedAt`.
   */
  public close(state: Exclude<TaskState, 'open'>, reason = ''): void {
    this.edit((doc) => {
      doc.state = state;
      doc.closedAt = isoSecond();
      if (state === 'abandoned' && reason.trim() !== '') doc.reason = reason.trim();
      else delete doc.reason;
    });
  }

  /** Append one deliverable per text, in order, and return the ones written. */
  public addDeliverables(texts: readonly string[]): Deliverable[] {
    const cleaned = texts.map((t) => oneLine('add', t));
    if (cleaned.length === 0) throw YanError.usage('deliverable_usage', 'nothing to add - pass the text of at least one deliverable');
    const added: Deliverable[] = [];
    this.edit((doc, data) => {
      let next = data.nextDeliverable;
      for (const text of cleaned) {
        added.push({ id: `d${next}`, text, status: 'todo' });
        next += 1;
      }
      doc.nextDeliverable = next;
      doc.deliverables = [...data.deliverables, ...added];
    });
    return added;
  }

  /** Reword one, keeping its id and its status. */
  public editDeliverable(id: string, text: string): Deliverable {
    const cleaned = oneLine('edit', text);
    return this.replaceDeliverable(id, (d) => ({ ...d, text: cleaned }));
  }

  /** Mark one delivered today. */
  public deliverableDone(id: string): Deliverable {
    return this.replaceDeliverable(id, (d) => ({ id: d.id, text: d.text, status: 'done', doneAt: localDay() }));
  }

  /** Give one up, with the reason it is not being done. */
  public abandonDeliverable(id: string, reason: string): Deliverable {
    const why = oneLine('abandon', reason);
    return this.replaceDeliverable(id, (d) => ({ id: d.id, text: d.text, status: 'abandoned', reason: why }));
  }

  private replaceDeliverable(id: string, edit: (d: Deliverable) => Deliverable): Deliverable {
    let written: Deliverable | undefined;
    this.edit((doc, data) => {
      if (!data.deliverables.some((d) => d.id === id)) {
        const ids = data.deliverables.map((d) => d.id);
        throw YanError.usage('deliverable_usage',
          `no such deliverable: ${id} - ${ids.length === 0 ? 'this task has none yet' : `this task has ${ids.join(' ')}`}`,
        );
      }
      doc.deliverables = data.deliverables.map((d) => {
        if (d.id !== id) return d;
        written = edit(d);
        return written;
      });
    });
    return written as Deliverable;
  }

  /**
   * Read-modify-write. `edit` gets the raw document, to change, and the
   * validated one, to read from; anything it throws leaves the file untouched.
   */
  private edit(edit: (doc: Record<string, unknown>, data: TaskData) => void): void {
    editJson(this.require(), (current) => {
      const doc = { ...(recordOrNone(current) ?? {}) };
      edit(doc, validate(current, this));
      return doc;
    });
  }

  /** @throws YanError `task_missing` when there is no task.json. */
  private require(): string {
    if (!existsSync(this.file)) {
      throw YanError.usage('task_missing', `no such task: ${this.id} - 'yan ls --status all' lists them`);
    }
    return this.file;
  }

  public static isId(id: string): boolean {
    return isRecordId(id);
  }

  /** Does this string name a task? False for a malformed id, never a throw. */
  public static exists(id: string): boolean {
    return Task.isId(id) && new Task(id).exists();
  }

  /**
   * Create a task under the next free `t<NNN>`: task.json and an empty
   * brief.md. log.md appears with its first line.
   *
   * @param repo the remote URL of the repository its tree is cut from, or
   *   `''` for a task with no tree.
   * @param scope the repository's packages it is about; `[]` for all of it.
   */
  public static create(title: string, repo = '', scope: readonly string[] = []): Task {
    const name = title.trim();
    if (name === '' || /[\r\n]/.test(name)) throw YanError.usage('task_usage', 'a task needs a title, on one line');
    const task = new Task(nextNumbered(Task.list(), 't', 3));
    mkdirSync(task.dir, { recursive: true });
    initJson(task.file, {
      version: 2,
      id: task.id,
      title: name,
      state: 'open',
      createdAt: isoSecond(),
      ...(repo === '' ? {} : { repo }),
      ...(scope.length === 0 ? {} : { scope: [...scope] }),
      nextDeliverable: 1,
      deliverables: [],
    });
    if (!existsSync(task.brief)) writeFileSync(task.brief, '');
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
      .sort(byCodePoint);
  }
}

/**
 * One line of text, trimmed.
 *
 * @throws YanError `deliverable_usage` when it is empty or spans lines.
 */
function oneLine(what: string, text: string): string {
  const cleaned = (text ?? '').trim();
  if (cleaned === '') throw YanError.usage('deliverable_usage', `${what}: the text is required and cannot be blank`);
  if (/[\r\n]/.test(cleaned)) throw YanError.usage('deliverable_usage', `${what}: a deliverable is one line`);
  return cleaned;
}

/**
 * The parsed document, or a refusal naming the file and the first thing wrong
 * with it.
 *
 * @throws YanError `task_invalid`.
 */
function validate(raw: unknown, task: Task): TaskData {
  const refuse = (why: string): never => {
    throw new YanError('task_invalid', `${task.file} is not a task record: ${why}`);
  };

  const doc = recordOrNone(raw);
  if (doc === undefined) return refuse('the top level is not an object');
  if (doc.version !== 2) {
    return refuse(`version is ${JSON.stringify(doc.version)} and this build reads version 2 - migrate the vault with scripts/migrate-v4.mjs`);
  }
  const state = doc.state;
  if (typeof state !== 'string' || !(TASK_STATES as readonly string[]).includes(state)) {
    return refuse(`state is ${JSON.stringify(state)} - one of: ${TASK_STATES.join(' ')}`);
  }

  const deliverables = validateDeliverables(doc.deliverables ?? [], refuse);
  const highest = Math.max(0, ...deliverables.map((d) => Number(/^d(\d+)$/.exec(d.id)?.[1] ?? 0)));
  const stated = doc.nextDeliverable;
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

  const createdAt = text(doc.createdAt);
  const closedAt = text(doc.closedAt);
  const reason = text(doc.reason);
  const repo = text(doc.repo);
  // A path edited into something else is dropped, not refused: scope only steers.
  const scope = Array.isArray(doc.scope) ? doc.scope.filter((p): p is string => typeof p === 'string' && p.trim() !== '') : [];
  return {
    version: 2,
    id: text(doc.id) ?? task.id,
    title: text(doc.title) ?? '',
    state: state as TaskState,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(reason === undefined ? {} : { reason }),
    ...(repo === undefined ? {} : { repo }),
    ...(scope.length === 0 ? {} : { scope }),
    // Kept in the file so a deliverable removed by hand cannot make the next
    // `add` reuse an id somebody has already quoted.
    nextDeliverable: typeof stated === 'number' && Number.isInteger(stated) && stated > highest ? stated : highest + 1,
    deliverables,
  };
}

function validateDeliverables(raw: unknown, refuse: (why: string) => never): Deliverable[] {
  if (!Array.isArray(raw)) return refuse('"deliverables" is not an array');
  const seen = new Set<string>();
  const out: Deliverable[] = [];
  for (const [i, entry] of raw.entries()) {
    const d = recordOrNone(entry);
    if (d === undefined) return refuse(`deliverables[${i}] is not an object`);
    const { id, text, status } = d;
    if (typeof id !== 'string' || id === '') return refuse(`deliverables[${i}] has no id`);
    if (seen.has(id)) return refuse(`two deliverables share the id ${id}`);
    seen.add(id);
    if (typeof text !== 'string' || text.trim() === '') return refuse(`${id} has no text`);

    if (status === 'todo') {
      out.push({ id, text, status });
    } else if (status === 'done') {
      if (typeof d.doneAt !== 'string' || !isDate(d.doneAt)) return refuse(`${id} is done but its doneAt is not a YYYY-MM-DD`);
      // Refs come from deliverables marked before v4; nothing writes them now.
      const refs = Array.isArray(d.refs) ? d.refs.filter((r): r is string => typeof r === 'string' && r !== '') : [];
      out.push({ id, text, status, doneAt: d.doneAt, ...(refs.length > 0 ? { refs } : {}) });
    } else if (status === 'abandoned') {
      if (typeof d.reason !== 'string' || d.reason.trim() === '') return refuse(`${id} is abandoned and gives no reason`);
      out.push({ id, text, status, reason: d.reason });
    } else {
      return refuse(`${id} has status ${JSON.stringify(status)} - one of: todo done abandoned`);
    }
  }
  return out;
}
