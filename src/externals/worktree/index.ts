/**
 * The pool of worktrees serving one main clone: lease a tree, cut a branch in
 * it, hand it back afterwards.
 *
 * Returning a tree resets and cleans it: uncommitted work in it is gone, and
 * the orphan-commit guard refuses the return rather than let that happen
 * silently. Gitignored build state — node_modules, caches — survives on
 * purpose, so the next lease starts warm.
 */

export { WorktreePool } from './worktree.js';
// Exported because callers have to tell "the pool is full" from "the lease
// failed": same exception, completely different thing to go and look at. The
// distinction is `WorktreeError.codes.full`, so it can be branched on rather
// than matched out of a message.
export { WorktreeError } from './errors.js';
export type { Lease, LeaseGrant, LeaseRow, ReturnExpectation, ReturnOptions } from './types.js';
