import { createHash } from 'node:crypto';
import { Drafts, PICTURE_TYPES, type DraftFile } from '../../records/drafts/index.js';
import { isYanError } from '../../util/error.js';
import type { Draft, DraftSaved, PictureSaved } from './wire.js';

/**
 * `user`'s drafts as yan serve's page reads and writes them: on this
 * machine's disk, where a write is done the moment it is made, and not as a
 * commit shows them. They are `user`'s alone, so nothing has to pass through
 * git to count; committing and pushing them is `LaterPush`'s, a while after
 * the writing stops, so the page never waits on the network.
 */

/** What serve answers: a status, and JSON or a line of text. */
export interface Answer {
  readonly status: number;
  readonly json?: unknown;
  readonly text?: string;
}

/** A picture pasted into a draft is at most this large. */
export const PICTURE_LIMIT = 20 * 1024 * 1024;

/** A fingerprint of a draft's text, git's for a blob of it, which the page names as what an edit began from. */
export function fingerprint(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function wire(d: DraftFile): Draft {
  return { id: d.id, title: d.title, text: d.body, sha: fingerprint(d.body), begun: Math.floor(Date.parse(d.updated) / 1000), task: d.task ?? null };
}

/** Every draft as it is on disk, newest first. */
export function listDrafts(): Draft[] {
  return new Drafts().all().map(wire);
}

/** Refused, the draft not being what the edit began from: what it is now, null once it is gone. */
function changed(now: DraftFile | undefined): Answer {
  return { status: 409, json: { error: now === undefined ? 'that draft is not there any more' : 'that draft changed since this page read it', theirs: now === undefined ? null : wire(now) } };
}

function refused(err: unknown): Answer {
  return { status: isYanError(err) ? 400 : 500, text: err instanceof Error ? err.message : String(err) };
}

/**
 * `{ id, sha, text }`: a draft written whole, `id` null for a new one, named
 * for its first line. `sha` is the draft the writing began from: when the
 * file is no longer that, written elsewhere meanwhile or gone, it is
 * refused with the draft as it is now, for the page to settle with `user`.
 */
export function writeDraft(given: Record<string, unknown>, touched: () => void): Answer {
  const [id, sha, text] = [given.id, given.sha, given.text];
  if ((id !== null && typeof id !== 'string') || (id !== null && typeof sha !== 'string') || typeof text !== 'string') {
    return { status: 400, text: 'id (null for a new draft), sha and text are needed' };
  }
  if (text.trim() === '') return { status: 400, text: 'a draft cannot be blank: deleting one is /api/draft/delete' };
  const drafts = new Drafts();
  if (id !== null) {
    const now = drafts.get(id);
    if (now === undefined || fingerprint(now.body) !== sha) return changed(now);
  }
  try {
    const kept = drafts.write(id ?? undefined, text) as string;
    touched();
    return { status: 200, json: { draft: wire(drafts.get(kept) as DraftFile) } satisfies DraftSaved };
  } catch (err) {
    return refused(err);
  }
}

/** `{ id, sha }`: a draft deleted, its pictures with it, unless it changed since it was read; one already gone is gone. */
export function deleteDraft(given: Record<string, unknown>, touched: () => void): Answer {
  const [id, sha] = [given.id, given.sha];
  if (typeof id !== 'string' || typeof sha !== 'string') return { status: 400, text: 'id and sha are needed' };
  const drafts = new Drafts();
  const now = drafts.get(id);
  if (now === undefined) return { status: 200, json: { draft: null } satisfies DraftSaved };
  if (fingerprint(now.body) !== sha) return changed(now);
  drafts.remove(id);
  touched();
  return { status: 200, json: { draft: null } satisfies DraftSaved };
}

/**
 * A picture, as its bytes, kept in the folder beside draft `draft`; with no
 * draft, a new one is made holding only the picture. Answers how the
 * draft's Markdown names it, and the draft as it is then.
 */
export function addPicture(draft: string | null, type: string, bytes: Buffer, touched: () => void): Answer {
  const ext = PICTURE_TYPES[type.split(';')[0]?.trim().toLowerCase() ?? ''];
  if (ext === undefined) return { status: 415, text: `a picture is ${Object.keys(PICTURE_TYPES).join(', ')}` };
  if (bytes.length === 0) return { status: 400, text: 'the picture is empty' };
  const drafts = new Drafts();
  try {
    let id = draft;
    if (id === null) {
      // Made to hold the picture: its Markdown is the picture alone, once the picture has its name.
      id = drafts.write(undefined, '·') as string;
      const path = drafts.addPicture(id, bytes, ext);
      drafts.write(id, `![](${path})\n`);
      touched();
      return { status: 200, json: { path, draft: wire(drafts.get(id) as DraftFile) } satisfies PictureSaved };
    }
    const path = drafts.addPicture(id, bytes, ext);
    touched();
    return { status: 200, json: { path, draft: wire(drafts.get(id) as DraftFile) } satisfies PictureSaved };
  } catch (err) {
    return refused(err);
  }
}
