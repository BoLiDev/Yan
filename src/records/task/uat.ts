import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { editJson, initJson, readJsonIfPresent } from '../../util/json.js';
import { asString, recordOrNone } from '../../util/narrow.js';
import { isInside, normalizePath } from '../../util/paths.js';
import { YanError } from '../../util/error.js';
import type { Task } from './task.js';

/**
 * `tasks/<id>/artifacts/uat/uat.json`: what `user` checks each deliverable
 * by. Every screenshot or recording in uat/ is recorded with the
 * deliverables it shows and what it shows of them, and a deliverable nothing
 * on screen can show gets a note of how it was checked. The agent records
 * each as it makes it, so the evidence is gathered deliverable by
 * deliverable rather than as a sweep of the product, and whether a
 * deliverable is done can be judged from it. A report places each file
 * under its deliverables from here, not from its name.
 *
 *   { "version": 1,
 *     "files": { "d9-before.png": { "for": ["d9"], "shows": "…", "side": "before" } },
 *     "notes": { "d6": "…" } }
 *
 * Only `yan uat` writes it. A yan from before it never reads it.
 */

export const UAT_SIDES = ['before', 'after'] as const;
export type UatSide = (typeof UAT_SIDES)[number];

export interface UatFile {
  /** Under uat/, with forward slashes. */
  readonly path: string;
  /** Deliverable ids, in the order given. */
  readonly for: readonly string[];
  readonly shows: string;
  /** Half of a pair the report shows side by side. */
  readonly side?: UatSide;
}

export interface UatData {
  readonly files: readonly UatFile[];
  /** How a deliverable was checked, by its id. */
  readonly notes: Readonly<Record<string, string>>;
}

const ID = /^d[1-9]\d*$/;

function line(what: string, text: string, noun: string): string {
  const cleaned = (text ?? '').trim();
  if (cleaned === '') throw YanError.usage('uat_usage', `${what}: ${noun} is required and cannot be blank`);
  if (/[\r\n]/.test(cleaned)) throw YanError.usage('uat_usage', `${what}: ${noun} is one line`);
  return cleaned;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [];
}

/** The file read as far as it can be: an entry it cannot read is left out, never a refusal. */
function parse(raw: unknown): UatData {
  const doc = recordOrNone(raw) ?? {};
  const files = Object.entries(recordOrNone(doc.files) ?? {}).flatMap(([path, value]): UatFile[] => {
    const entry = recordOrNone(value);
    if (entry === undefined) return [];
    const side = entry.side === 'before' || entry.side === 'after' ? entry.side : undefined;
    return [{ path, for: stringList(entry.for), shows: asString(entry.shows), ...(side === undefined ? {} : { side }) }];
  });
  const notes = Object.fromEntries(
    Object.entries(recordOrNone(doc.notes) ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'),
  );
  return { files, notes };
}

/** A handle on one task's uat.json, reading it fresh on every call. */
export class Uat {
  public readonly dir: string;
  public readonly file: string;

  public constructor(private readonly task: Task) {
    this.dir = normalizePath(join(task.dir, 'artifacts', 'uat'));
    this.file = normalizePath(join(this.dir, 'uat.json'));
  }

  /** What is recorded; nothing yet when there is no file. */
  public read(): UatData {
    try {
      return parse(readJsonIfPresent(this.file));
    } catch {
      throw new YanError('uat_invalid', `${this.file} is not valid JSON - fix it by hand, or restore it from the vault's git history`);
    }
  }

  /**
   * Record `path` as showing `ids`: what it shows of them, and whether it is
   * the before or the after of a pair. A file recorded again is replaced.
   *
   * @returns the path under uat/, and whether an entry was replaced.
   * @throws YanError `uat_usage` for a file that is not in uat/ or not there,
   *   or a deliverable the task does not have or gave up.
   */
  public add(path: string, ids: readonly string[], shows: string, side?: UatSide): { path: string; replaced: boolean } {
    const key = this.keyOf(path);
    const wanted = this.deliverables('add', ids);
    const text = line('add', shows, 'what it shows');
    let replaced = false;
    this.edit((doc) => {
      const files = { ...(recordOrNone(doc.files) ?? {}) };
      replaced = key in files;
      // Kept in place, so a field a later yan added to the entry survives.
      const { side: _, ...kept } = recordOrNone(files[key]) ?? {};
      files[key] = { ...kept, for: wanted, shows: text, ...(side === undefined ? {} : { side }) };
      doc.files = files;
    });
    return { path: key, replaced };
  }

  /** Note how `ids` were checked where nothing on screen shows them; a note given again is replaced. */
  public note(ids: readonly string[], how: string): string[] {
    const wanted = this.deliverables('note', ids);
    const text = line('note', how, 'how it was checked');
    this.edit((doc) => {
      doc.notes = { ...(recordOrNone(doc.notes) ?? {}), ...Object.fromEntries(wanted.map((id) => [id, text])) };
    });
    return wanted;
  }

  /**
   * Forget a file's entry, by its path, or a deliverable's note, by its id.
   * The file itself stays.
   */
  public remove(target: string): string {
    const name = line('rm', target, 'a file or a deliverable');
    const data = this.read();
    if (ID.test(name) && name in data.notes) {
      this.edit((doc) => {
        const notes = { ...(recordOrNone(doc.notes) ?? {}) };
        delete notes[name];
        doc.notes = notes;
      });
      return `the note on ${name}`;
    }
    const key = this.relativeKey(name);
    if (!data.files.some((f) => f.path === key)) {
      throw YanError.usage('uat_usage', `nothing is recorded for ${name} - 'yan uat' lists what is`);
    }
    this.edit((doc) => {
      const files = { ...(recordOrNone(doc.files) ?? {}) };
      delete files[key];
      doc.files = files;
    });
    return key;
  }

  /** The path under uat/, forward slashes: a relative one is read from uat/, an absolute one must be inside it. */
  private relativeKey(path: string): string {
    const full = isAbsolute(path) ? resolve(path) : resolve(this.dir, path);
    if (!isInside(this.dir, normalizePath(full)) || normalizePath(full) === this.dir) {
      throw YanError.usage('uat_usage', `${path} is not in ${this.dir} - save it there first`);
    }
    return relative(this.dir, full).split(sep).join('/');
  }

  /** `relativeKey`, for a file that has to be there. */
  private keyOf(path: string): string {
    const key = this.relativeKey(line('add', path, 'a file'));
    const full = join(this.dir, key);
    if (!existsSync(full) || !statSync(full).isFile()) {
      throw YanError.usage('uat_usage', `there is no file ${key} in ${this.dir} - save it there first`);
    }
    if (key === 'uat.json') throw YanError.usage('uat_usage', 'uat.json is the record itself, not evidence');
    return key;
  }

  /** The ids, each a deliverable of the task that is not given up, each once. */
  private deliverables(what: string, ids: readonly string[]): string[] {
    const wanted = [...new Set(ids.flatMap((i) => i.split(',')).map((i) => i.trim()).filter((i) => i !== ''))];
    if (wanted.length === 0) throw YanError.usage('uat_usage', `${what}: which deliverable? --for d1 - 'yan context' lists them`);
    const all = this.task.read().deliverables;
    for (const id of wanted) {
      const d = all.find((x) => x.id === id);
      if (d === undefined) throw YanError.usage('uat_usage', `${this.task.id} has no deliverable ${id} - 'yan context' lists them`);
      if (d.status === 'abandoned') throw YanError.usage('uat_usage', `${id} was given up, so there is nothing to check it by`);
    }
    return wanted;
  }

  private edit(change: (doc: Record<string, unknown>) => void): void {
    this.read();
    initJson(this.file, { version: 1, files: {}, notes: {} });
    editJson(this.file, (current) => {
      const doc = { ...(recordOrNone(current) ?? {}) };
      change(doc);
      return doc;
    });
  }
}
