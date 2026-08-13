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
export { WorktreeError } from './errors.js';
export type { Lease, LeaseGrant, LeaseRow, ReturnExpectation, ReturnOptions } from './types.js';
