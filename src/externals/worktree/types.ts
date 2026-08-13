/** The vocabulary the worktree pool speaks. */

/** A lease record as it is written to disk. */
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
 * One row of `status()`. Carries no `pid`: a lease whose owning process died
 * is still held, so the pid says nothing about the tree.
 */
export type LeaseRow = Omit<Lease, 'version' | 'pid'>;

/** An optional identity check for `return()`. An absent field is not compared. */
export interface ReturnExpectation {
  readonly leaseId?: string;
  readonly holder?: string;
}

/**
 * What `return()` takes. `force` skips the orphan-commit guard, and only a
 * command carrying `user`'s consent may set it.
 */
export interface ReturnOptions extends ReturnExpectation {
  readonly force?: boolean;
}
