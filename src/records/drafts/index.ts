/**
 * `tasks/<id>/artifacts/drafts/`: `user`'s own notes about one task, in the
 * same on-disk format as the `draft` CLI so a note moves between the two by
 * moving the file. yan reads them; only `user`, at a keyboard, writes them.
 */

export { Drafts, discardIfUntouched, isValidId, newDraftId, slugify, titleTemplate } from './drafts.js';
export type { Draft, DraftSummary, ListOptions, SearchHit } from './drafts.js';
