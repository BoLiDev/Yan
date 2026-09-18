import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Task } from '../task/index.js';
import { normalizePath } from '../../util/paths.js';

/**
 * One task's drafts folder. Ported from cli-kit's `drafts.ts` rather than
 * imported from it, so a machine without cli-kit still lists them.
 *
 *   2026-09-16_051516.md                  an untitled draft
 *   2026-09-16_051516-parser-ideas.md     one started with a title
 *
 * The title is the first non-blank line with any leading `#` stripped;
 * `updated` is the file's mtime; every list is newest first. Reading never
 * creates the folder — a session start is a read — and writing creates it on
 * the first draft.
 */

const EXT = '.md';

export interface DraftSummary {
  readonly id: string;
  readonly title: string;
  /** ISO 8601, from the file's modification time. */
  readonly updated: string;
  /** Body after the title, whitespace-collapsed, at most 120 characters. */
  readonly preview: string;
}

export interface Draft extends DraftSummary {
  readonly path: string;
  readonly body: string;
}

export interface SearchHit extends DraftSummary {
  /** Text around the first match. */
  readonly snippet: string;
}

export interface ListOptions {
  readonly limit?: number;
  /** Only drafts modified at or after this time. */
  readonly since?: Date;
}

interface Entry {
  readonly id: string;
  readonly path: string;
  readonly mtimeMs: number;
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Ids are filename stems; anything that could leave the folder is not one. */
export function isValidId(id: string): boolean {
  return ID_RE.test(id) && !id.includes('..');
}

function headline(body: string): { title: string; preview: string } {
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
  return { id: e.id, path: e.path, body, updated: new Date(e.mtimeMs).toISOString(), ...headline(body) };
}

function summary(d: Draft): DraftSummary {
  return { id: d.id, title: d.title, updated: d.updated, preview: d.preview };
}

export class Drafts {
  /** Forward slashes on every platform, like `Task.dir`. */
  public readonly dir: string;

  public constructor(task: string) {
    this.dir = normalizePath(join(new Task(task).dir, 'artifacts', 'drafts'));
  }

  public pathFor(id: string): string {
    return normalizePath(join(this.dir, id + EXT));
  }

  /** The folder, created if this is the first draft. */
  public ensureDir(): string {
    mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  private entries(): Entry[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const found: Entry[] = [];
    for (const name of names) {
      if (!name.endsWith(EXT)) continue;
      const path = this.pathFor(name.slice(0, -EXT.length));
      const st = statSync(path);
      if (!st.isFile()) continue;
      found.push({ id: name.slice(0, -EXT.length), path, mtimeMs: st.mtimeMs });
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return found;
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
    const path = this.pathFor(id);
    if (!existsSync(path)) return undefined;
    return load({ id, path, mtimeMs: statSync(path).mtimeMs });
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
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp =
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}` +
    `_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
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
