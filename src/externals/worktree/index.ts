/**
 * The pool of worktrees serving each main clone: lease a task a tree on a
 * detached HEAD, hand them all back when the task is done. The pool never
 * makes a branch; the agent in the tree makes its own.
 *
 * Returning a tree resets and cleans it and takes it off any branch, and the
 * guard refuses the return while it holds work that exists nowhere else. Gitignored build state —
 * node_modules, caches — survives on purpose, so the next lease starts warm.
 */

export { WorktreePool, leasesHeldBy, returnTrees } from './worktree.js';
export { treeState } from './guard.js';
export type { TreeState } from './guard.js';
export type { LeaseGrant, LeaseRow } from './types.js';
