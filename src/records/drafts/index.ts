/**
 * `drafts/`: `user`'s own notes, the vault's rather than one task's, so every
 * agent on every task reads them; in the same on-disk format as the `draft`
 * CLI, so a note moves between the two by moving the file. Those kept per
 * task before, in `tasks/<id>/drafts/`, are read where they are. An agent
 * reads them; only `user` writes them, at a keyboard or on yan serve's page.
 */

export { Drafts, discardIfUntouched, headline, newDraftId, titleTemplate } from './drafts.js';
export type { DraftSummary } from './drafts.js';
