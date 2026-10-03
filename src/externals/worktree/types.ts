/** The vocabulary the worktree pool speaks. */

/** A lease record as it is written to disk. */
export interface Lease {
  readonly version: number;
  readonly slot: number;
  readonly path: string;
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
