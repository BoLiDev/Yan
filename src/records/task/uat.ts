import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
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
 * `yan uat` writes it, and so does a deliverable taken out or moved, whose
 * new number every entry and file name follows. A yan from before it never
 * reads it.
 */

/**
 * `before` and `after` are the halves of a pair the report shows side by
 * side; `new` is something that did not exist before the task, which has no
 * before to shoot and is shown on its own.
 */
export const UAT_SIDES = ['before', 'after', 'new'] as const;
export type UatSide = (typeof UAT_SIDES)[number];

export interface UatFile {
  /** Under uat/, with forward slashes. */
  readonly path: string;
  /** Deliverable ids, in the order given. */
  readonly for: readonly string[];
  readonly shows: string;
  /** Half of a pair, or new: see UAT_SIDES. */
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
export function parseUat(raw: unknown): UatData {
  const doc = recordOrNone(raw) ?? {};
  const files = Object.entries(recordOrNone(doc.files) ?? {}).flatMap(([path, value]): UatFile[] => {
    const entry = recordOrNone(value);
    if (entry === undefined) return [];
    const side = UAT_SIDES.find((s) => s === entry.side);
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
      return parseUat(readJsonIfPresent(this.file));
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

  /**
   * Follow the deliverables to their new numbers: `ids` maps every one kept
   * to its new id, and `gone` holds the one taken out. Its note goes, and a
   * file recorded only for it, or named only for it and recorded for
   * nothing, is deleted with its entry, since it showed nothing else. Every
   * other entry, note and file name takes the new numbers: file names too,
   * because the agent names a file for what it shows.
   *
   * It writes after task.json has been, so the caller reads uat.json first:
   * one it cannot read must stop the change before either file moves.
   */
  public renumber(ids: ReadonlyMap<string, string>, gone: ReadonlySet<string>): Renumbered {
    if (!existsSync(this.dir)) return { renamed: [], deleted: [] };
    const recorded = new Map(this.read().files.map((f) => [f.path, f]));
    const kept = (list: readonly string[]): string[] => list.flatMap((id) => (gone.has(id) ? [] : [ids.get(id) ?? id]));
    const dropped = (list: readonly string[]): boolean => list.length > 0 && kept(list).length === 0;
    const files = this.listed();
    const deleted: string[] = [];
    const moves: [string, string][] = [];
    for (const path of files) {
      const entry = recorded.get(path);
      const name = renamed(posix.basename(path), ids, gone, kept(entry?.for ?? []));
      if ((entry !== undefined && dropped(entry.for)) || name === undefined) deleted.push(path);
      else if (name !== posix.basename(path)) moves.push([path, posix.join(posix.dirname(path), name)]);
    }
    const targets = untangled(moves, files.filter((p) => !deleted.includes(p) && !moves.some(([from]) => from === p)));
    for (const path of deleted) unlinkSync(join(this.dir, path));
    // Through a name nothing has, so d4 → d3 never lands on a d3 still waiting to become d2.
    const parked = targets.map(([from, to], i): [string, string] => {
      const aside = posix.join(posix.dirname(from), `${PARKED}${i}-${posix.basename(from)}`);
      renameSync(join(this.dir, from), join(this.dir, aside));
      return [aside, to];
    });
    for (const [aside, to] of parked) renameSync(join(this.dir, aside), join(this.dir, to));

    const pathOf = new Map(targets);
    if (existsSync(this.file)) {
      this.edit((doc) => {
        const entries = Object.entries(recordOrNone(doc.files) ?? {}).flatMap(([path, value]): [string, unknown][] => {
          const entry = recordOrNone(value);
          if (entry === undefined || dropped(stringList(entry.for))) return [];
          return [[pathOf.get(path) ?? path, { ...entry, for: kept(stringList(entry.for)) }]];
        });
        doc.files = Object.fromEntries(entries);
        doc.notes = Object.fromEntries(Object.entries(recordOrNone(doc.notes) ?? {})
          .flatMap(([id, how]) => (gone.has(id) ? [] : [[ids.get(id) ?? id, how]])));
      });
    }
    return { renamed: targets, deleted };
  }

  /** Every file under uat/ but uat.json, by its path there with forward slashes. */
  private listed(): string[] {
    return readdirSync(this.dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => relative(this.dir, join(e.parentPath, e.name)).split(sep).join('/'))
      .filter((p) => p !== 'uat.json' && !posix.basename(p).startsWith(PARKED))
      .sort();
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

/** What following new numbers did in uat/: each file renamed, from and to, and each deleted. */
export interface Renumbered {
  readonly renamed: readonly (readonly [string, string])[];
  readonly deleted: readonly string[];
}

/** Where a file waits during a renumbering, under a name nothing else has. */
const PARKED = '.yan-renumber-';

/** A deliverable's id in a file name, with the dash after it: d3 in d3-after.png or d2-d3.webm, never in add3.png or d30. */
const NAMED = /(?<![A-Za-z0-9])(d\d+)(?![0-9])([-_]?)/g;

/**
 * `name` with the ids in it renumbered, and the one taken out dropped with
 * its dash. A name with only that one in it takes the ids the file is still
 * recorded for, `still`; with none, it is `undefined`: the file showed only
 * what is gone.
 */
function renamed(name: string, ids: ReadonlyMap<string, string>, gone: ReadonlySet<string>, still: readonly string[]): string | undefined {
  const named = [...name.matchAll(NAMED)].map((m) => m[1] ?? '');
  if (named.length === 0) return name;
  const onlyGone = named.every((id) => gone.has(id));
  if (onlyGone && still.length === 0) return undefined;
  let first = true;
  const out = name.replace(NAMED, (_, id: string, dash: string) => {
    if (!gone.has(id)) return (ids.get(id) ?? id) + dash;
    if (!onlyGone || !first) return '';
    first = false;
    return still.join('-') + dash;
  });
  // An id taken from the end or the middle leaves a dash before the extension, or two together.
  return out.replace(/[-_]{2,}/g, '-').replace(/^[-_]+/, '').replace(/[-_]+(\.[^.]*)?$/, '$1');
}

/** The renames, a target already taken, by another rename or a file staying where it is, given -2, -3… before its extension. */
function untangled(moves: readonly [string, string][], staying: readonly string[]): [string, string][] {
  const taken = new Set(staying);
  return moves.map(([from, to]) => {
    const ext = posix.extname(to);
    let target = to;
    for (let n = 2; taken.has(target); n += 1) target = `${to.slice(0, to.length - ext.length)}-${n}${ext}`;
    taken.add(target);
    return [from, target];
  });
}
