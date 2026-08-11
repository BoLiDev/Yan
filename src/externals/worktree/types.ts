/**
 * The vocabulary the worktree pool speaks. Nothing here knows about git, the
 * file system, or how a lease is stored — those are `lease.ts` and `layout.ts`.
 */

/** A lease record as it is written to disk. `version` is the schema hook. */
export interface Lease {
  readonly version: number;
  readonly slot: number;
  readonly path: string;
  readonly branch: string;
  readonly base: string;
  readonly holder: string;
  readonly lease_id: string;
  readonly at: number;
  readonly pid: number;
}

/** What a caller gets back when a tree is leased to it. */
export interface LeaseGrant {
  readonly path: string;
  readonly lease_id: string;
  readonly holder: string;
}

/**
 * One row of `status()`.
 *
 * Deliberately not a `Lease`: `version` is a storage detail and `pid` is not a
 * fact about the tree — a lease whose owning process died is still held
 * (worktree.md §7), so reporting the pid invites the wrong conclusion.
 */
export type LeaseRow = Omit<Lease, 'version' | 'pid'>;

/** An optional identity check for `return()`. An absent field is not compared. */
export interface ReturnExpectation {
  readonly leaseId?: string;
  readonly holder?: string;
}

/**
 * What `return()` takes: the identity check, plus the one way past the
 * orphan-commit guard.
 *
 * `force` is NOT a convenience. boundaries.md §9.2 lists it as an action
 * `user` has to authorise — *forbidden, unless `user` says the changes can be
 * thrown away* — which is a different thing from forbidden. So the capability
 * lives here, where the guard is, and the authority lives in the one command
 * that can carry `user`'s answer in: `yan done --force`. `yan tree return`
 * deliberately exposes no flag for it (see `cli/tree.ts`).
 */
export interface ReturnOptions extends ReturnExpectation {
  readonly force?: boolean;
}
