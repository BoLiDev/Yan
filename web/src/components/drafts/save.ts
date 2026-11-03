import { ApiError, postJSON, type Draft, type DraftConflict, type DraftSaved, type PictureSaved, type Status } from '../../lib/api';
import { onStatus, queryClient } from '../../state/server';
import { toast } from '../../state/ui';

/** The draft begun on the page and not saved yet, shown under this in place of an id: no draft's file is named so. */
export const NEW = '+new';

/** The kinds of picture a draft takes, as serve keeps them. */
const PICTURES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const isPicture = (f: File): boolean => PICTURES.includes(f.type);

/**
 * Where in a draft's Markdown a click on it as drawn fell: the text under
 * the pointer found in the Markdown, which has it as written but for the
 * marks around it. The end when it cannot be told.
 */
export function offsetAt(x: number, y: number, source: string): number {
  const at = document.caretPositionFromPoint?.(x, y);
  const node = at?.offsetNode;
  if (!at || node?.nodeType !== Node.TEXT_NODE) return source.length;
  const found = source.indexOf(node.textContent ?? '');
  return found < 0 ? source.length : found + at.offset;
}

// The drafts as the page has them are changed the moment serve says a write is done, newest first, so nothing waits on fetching them again.
const newest = (a: Draft, b: Draft): number => b.changed - a.changed || b.id.localeCompare(a.id);
function upsert(d: Draft): void {
  queryClient.setQueryData<readonly Draft[]>(['drafts'], (list = []) => [d, ...list.filter((x) => x.id !== d.id)].sort(newest));
}
function drop(id: string): void {
  queryClient.setQueryData<readonly Draft[]>(['drafts'], (list = []) => list.filter((x) => x.id !== id));
}

/** A write refused, the draft not being what it began from: what it is now, null once deleted. */
export class Conflicted extends Error {
  constructor(readonly theirs: Draft | null) {
    super(theirs === null ? 'that draft was deleted elsewhere' : 'that draft changed elsewhere');
  }
}

/** The drafts deleted from this page, which a write still on its way is not to bring back. */
const deleted = new Set<string>();
export const wasDeleted = (id: string | null): boolean => id !== null && deleted.has(id);

/** Writes on their way, which asking for the push waits for, so it takes them. */
const writing = new Set<Promise<unknown>>();
function tracked<T>(p: Promise<T>): Promise<T> {
  writing.add(p);
  void p.then(() => writing.delete(p), () => writing.delete(p));
  return p;
}

/**
 * A draft written whole on this machine through serve, which is done at
 * once: `id` null for a new one, `sha` the draft as the writing began.
 * Refused as changed elsewhere, it throws `Conflicted` with what it is now.
 */
export function writeDraft(id: string | null, sha: string, text: string): Promise<Draft> {
  return tracked((async () => {
    try {
      const { draft } = await postJSON<DraftSaved>('/api/draft', { id, sha, text });
      if (draft !== null) upsert(draft);
      return draft as Draft;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 409) throw err;
      const { theirs } = JSON.parse(err.message) as DraftConflict;
      if (theirs !== null) upsert(theirs);
      else if (id !== null) drop(id);
      throw new Conflicted(theirs);
    }
  })());
}

/**
 * A draft deleted, once asked: gone from the list at once, and put back,
 * saying why, if serve refuses it, as when it changed elsewhere meanwhile.
 */
export async function deleteDraft(d: Draft): Promise<boolean> {
  deleted.add(d.id);
  drop(d.id);
  try {
    await tracked(postJSON<DraftSaved>('/api/draft/delete', { id: d.id, sha: d.sha }));
    return true;
  } catch (err) {
    deleted.delete(d.id);
    if (err instanceof ApiError && err.status === 409) {
      const { theirs } = JSON.parse(err.message) as DraftConflict;
      if (theirs !== null) upsert(theirs);
      toast('Not deleted: it changed elsewhere since you opened it', true);
    } else {
      upsert(d);
      toast(`The draft was not deleted: ${(err as Error).message}`, true);
    }
    return false;
  }
}

/** A picture kept beside draft `id`, a new draft made for it when there is none; how its Markdown names it, and the draft. */
export function addPicture(id: string | null, file: File): Promise<PictureSaved> {
  return tracked((async () => {
    const r = await fetch(`/api/draft/picture${id === null ? '' : `?draft=${encodeURIComponent(id)}`}`, { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
    if (!r.ok) throw new ApiError(r.status, await r.text());
    const out = (await r.json()) as PictureSaved;
    upsert(out.draft);
    return out;
  })());
}

/** What was written here pushed now, the drafts' box being closed: once the writes on their way are done. */
export async function pushDrafts(): Promise<void> {
  await Promise.allSettled([...writing]);
  try {
    await onStatus(await postJSON<Status>('/api/push', {}));
  } catch {
    // serve tries again on its own on the next tick; the drafts are written here all the same.
  }
}
