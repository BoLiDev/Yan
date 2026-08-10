/**
 * The codes this module puts on a `YanError`.
 *
 * They are internal to the module: a caller branches on `error.code`, and the
 * string it compares against is part of the module's contract, but the
 * constants themselves are not something anyone outside needs to import.
 */

export const WORKTREE_USAGE = 'worktree_usage';
export const WORKTREE_FULL = 'worktree_full';
export const WORKTREE_FAILED = 'worktree_failed';

/**
 * The identity check refused the return. Nothing was touched.
 *
 * Its own code on purpose: an automatic retry has to tell "someone else holds
 * this tree now" apart from "the return failed", and that distinction is the
 * whole point of `--if-lease-id`.
 */
export const WORKTREE_MISMATCH = 'worktree_mismatch';
export const WORKTREE_MISMATCH_EXIT = 3;
