/**
 * The worktree pool — one of yan's three externals (architecture.md §4.3).
 *
 * What this module provides, in full:
 *
 *   new WorktreePool(clone)   the pool serving one main clone
 *     .get(size, base, branch, holder) → LeaseGrant   lease a tree, cut a branch in it
 *     .return(target, expect?)         → string       reset, clean, release
 *     .status()                        → LeaseRow[]   what is held, by whom
 *
 * Three capabilities. Everything else in this directory is how, not what:
 * `layout` (where things live), `lease` (the records), `git-facts` (what git
 * says), `guard` (would returning lose work), `errors` (the codes).
 *
 * The one property the whole module exists to protect:
 *
 *   RETURNING A TREE IS `git reset --hard` PLUS `git clean -fd`. NEVER -x.
 *
 * -x would delete the gitignored node_modules and build caches too, which turns
 * every lease back into a cold install, and nothing fails loudly when it
 * happens. See `guard.ts`.
 */

export { WorktreePool } from './worktree.js';
export type { Lease, LeaseGrant, LeaseRow, ReturnExpectation } from './types.js';
