import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { YanError } from '../../util/error.js';
import { normalizePath } from '../../util/paths.js';
import { localDay, localTime } from '../../util/time.js';
import { draftsDir, tasksDir } from '../../util/vault.js';

/**
 * The vault's drafts folder: `user`'s own notes, one folder for every task,
 * so every agent on every task can read them. Ported from cli-kit's
 * `drafts.ts` rather than imported from it, so a machine without cli-kit
 * still lists them.
 *
 *   drafts/2026-09-16_051516.md                  an untitled draft
 *   drafts/2026-09-16_051516-parser-ideas.md     one started with a title
 *
 * Drafts were once kept per task, in `tasks/<id>/drafts/`. Those are read
 * where they are, as drafts like any other, and edited there: a vault is
 * shared with machines whose yan still looks for them in their task, so
 * none is moved. A draft at the top wins an id one of those also has.
 *
 * The title is the first non-blank line with any leading `#` stripped;
 * `updated` is the file's mtime; every list is newest first. Reading never
 * creates the folder, and writing creates it on the first draft.
 */

const EXT = '.md';

export interface DraftSummary {
  readonly id: string;
  readonly title: string;
  /** The task whose folder holds it, for a draft from when drafts were kept per task; absent for the rest. */
  readonly task?: string;
  /** ISO 8601, from the file's modification time. */
  readonly updated: string;
  /** Body after the title, whitespace-collapsed, at most 120 characters. */
  readonly preview: string;
}

interface Draft extends DraftSummary {
  readonly path: string;
  readonly body: string;
}

interface SearchHit extends DraftSummary {
  /** Text around the first match. */
  readonly snippet: string;
}

interface ListOptions {
  readonly limit?: number;
  /** Only drafts modified at or after this time. */
  readonly since?: Date;
}

interface Entry {
  readonly id: string;
  readonly path: string;
  readonly mtimeMs: number;
  readonly task?: string;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Ids are filename stems; anything that could leave the folder is not one. */
export function isValidId(id: string): boolean {
  return ID_RE.test(id) && !id.includes('..');
}

/** A draft's title and the start of the rest of it, as every list shows them. */
export function headline(body: string): { title: string; preview: string } {
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const title = (lines[0] ?? '').replace(/^#+\s*/, '') || '(empty)';
  const preview = lines.slice(1).join(' ').replace(/\s+/g, ' ').slice(0, 120);
  return { title, preview };
}

function load(e: Entry): Draft {
  const body = readFileSync(e.path, 'utf8');
  return { id: e.id, path: e.path, body, updated: new Date(e.mtimeMs).toISOString(), ...headline(body), ...(e.task === undefined ? {} : { task: e.task }) };
}

function summary(d: Draft): DraftSummary {
  return { id: d.id, title: d.title, updated: d.updated, preview: d.preview, ...(d.task === undefined ? {} : { task: d.task }) };
}

/** The `.md` files directly in `dir`, as entries; none when it is not there. */
function filesIn(dir: string, task?: string): Entry[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const found: Entry[] = [];
  for (const name of names) {
    if (!name.endsWith(EXT)) continue;
    const id = name.slice(0, -EXT.length);
    const path = normalizePath(join(dir, name));
    const st = statSync(path);
    if (!st.isFile() || !isValidId(id)) continue;
    found.push({ id, path, mtimeMs: st.mtimeMs, ...(task === undefined ? {} : { task }) });
  }
  return found;
}

/** The drafts from when they were kept per task, each in its task's folder. */
function perTask(): Entry[] {
  let ids: string[];
  try {
    ids = readdirSync(tasksDir());
  } catch {
    return [];
  }
  return ids.flatMap((id) => filesIn(join(tasksDir(), id, 'drafts'), id));
}

export class Drafts {
  /** Forward slashes on every platform, like `Task.dir`. */
  public readonly dir: string;

  public constructor() {
    this.dir = normalizePath(draftsDir());
  }

  /** Where a new draft `id` is written. */
  public pathFor(id: string): string {
    return normalizePath(join(this.dir, id + EXT));
  }

  /** Where draft `id` is, at the top or in a task's folder from before; undefined when there is none. */
  public pathOf(id: string): string | undefined {
    if (!isValidId(id)) return undefined;
    return this.entries().find((e) => e.id === id)?.path;
  }

  /** The folder, created if this is the first draft. */
  public ensureDir(): string {
    mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  private entries(): Entry[] {
    const top = filesIn(this.dir);
    const ids = new Set(top.map((e) => e.id));
    const found = [...top, ...perTask().filter((e) => !ids.has(e.id))];
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return found;
  }

  /**
   * Draft `id` written whole, where it is; with no id, a new one at the
   * top, named for its first line. One written blank is removed, as the
   * editor's is. Returns its id, or undefined when nothing is kept.
   */
  public write(id: string | undefined, body: string): string | undefined {
    const path = id === undefined ? undefined : this.pathOf(id);
    if (id !== undefined && path === undefined) throw new YanError('draft_missing', `no draft ${id} in ${this.dir} - 'yan draft ls --plain' lists them`);
    if (body.trim() === '') {
      if (path !== undefined) unlinkSync(path);
      return undefined;
    }
    const text = body.endsWith('\n') ? body : `${body}\n`;
    if (path !== undefined) {
      writeFileSync(path, text, 'utf8');
      return id;
    }
    const named = newDraftId(headline(body).title.split(/\s+/).filter((w) => w !== ''));
    // Two begun in the same second under one title are two drafts, not one written over.
    let made = named;
    for (let n = 2; existsSync(this.pathFor(made)); n++) made = `${named}-${n}`;
    this.ensureDir();
    writeFileSync(this.pathFor(made), text, 'utf8');
    return made;
  }

  /** How many there are, without reading any. */
  public count(): number {
    return this.entries().length;
  }

  /** Newest first. */
  public list(opts: ListOptions = {}): DraftSummary[] {
    let found = this.entries();
    if (opts.since !== undefined) {
      const cutoff = opts.since.getTime();
      found = found.filter((e) => e.mtimeMs >= cutoff);
    }
    if (opts.limit !== undefined) found = found.slice(0, opts.limit);
    return found.map((e) => summary(load(e)));
  }

  public get(id: string): Draft | undefined {
    if (!isValidId(id)) return undefined;
    const e = this.entries().find((x) => x.id === id);
    return e === undefined ? undefined : load(e);
  }

  /** Case-insensitive substring search over the whole file, newest first. */
  public search(query: string, limit = 20): SearchHit[] {
    const q = query.toLowerCase();
    if (q === '') return [];
    const hits: SearchHit[] = [];
    for (const e of this.entries()) {
      const d = load(e);
      const at = d.body.toLowerCase().indexOf(q);
      if (at < 0) continue;
      const start = Math.max(0, at - 60);
      const end = Math.min(d.body.length, at + q.length + 60);
      const snippet = d.body.slice(start, end).replace(/\s+/g, ' ').trim();
      hits.push({ ...summary(d), snippet });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}

export function slugify(words: readonly string[]): string {
  return words
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** `2026-09-12_021212`, in local time, plus `-slug` when there are title words. */
export function newDraftId(words: readonly string[], now = new Date()): string {
  const stamp = `${localDay(now)}_${localTime(now, true).replace(/:/g, '')}`;
  const slug = slugify(words);
  return slug === '' ? stamp : `${stamp}-${slug}`;
}

/** What a titled draft starts as; the empty string for an untitled one. */
export function titleTemplate(words: readonly string[]): string {
  return words.length > 0 ? `# ${words.join(' ')}\n\n\n` : '';
}

/**
 * After the editor exits: delete the file if it is missing, blank, or still
 * what it started as. True when nothing was kept.
 */
export function discardIfUntouched(path: string, initial: string): boolean {
  if (!existsSync(path)) return true;
  const content = readFileSync(path, 'utf8');
  if (content.trim() !== initial.trim()) return false;
  unlinkSync(path);
  return true;
}
