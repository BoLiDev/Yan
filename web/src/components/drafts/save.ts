import { postJSON, type Draft, type DraftWritten } from '../../lib/api';
import { onStatus, queryClient } from '../../state/server';
import { toast, useUI, type KeptDraft } from '../../state/ui';

/** The draft begun on the page and not saved yet, shown under this in place of an id: no draft's file is named so. */
export const NEW = '+new';

/** A draft's title as serve says it: its first line with something in it, without a heading's marks. */
export function titleOf(text: string): string {
  const first = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== '') ?? '';
  return first.replace(/^#+\s*/, '') || '(empty)';
}

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

/**
 * A draft written on the page, saved: serve writes, commits and pushes it,
 * and the drafts are fetched again before it is said done, so what is shown
 * next begins from what was saved. One that fails is kept, and its box
 * opened on it again, being written, so nothing typed is lost, the box
 * having been left meanwhile or not.
 */
export async function saveDraft(draft: KeptDraft): Promise<DraftWritten | undefined> {
  try {
    return await post(draft, 'Saved the draft');
  } catch (err) {
    toast(`The draft was not saved: ${(err as Error).message}`, true);
    useUI.setState({ drafts: true, draftKept: draft });
    return undefined;
  }
}

/** A draft written, then the drafts fetched again; a push that failed is said. */
async function post(draft: KeptDraft, did: string): Promise<DraftWritten> {
  const out = await postJSON<DraftWritten>('/api/draft', draft);
  if (out.warning) toast(`${did}, but the push failed: ${out.warning}`);
  await queryClient.invalidateQueries({ queryKey: ['drafts'] });
  void onStatus(out.status);
  return out;
}

/**
 * A draft deleted from its menu in the list: written blank, which removes
 * it, as it was when it was asked for. True once it is gone; one refused
 * says why, and nothing is kept, as there was nothing written to keep.
 */
export async function removeDraft(draft: Draft): Promise<boolean> {
  try {
    await post({ id: draft.id, sha: draft.sha, text: '' }, 'Deleted the draft');
    return true;
  } catch (err) {
    toast(`The draft was not deleted: ${(err as Error).message}`, true);
    return false;
  }
}
