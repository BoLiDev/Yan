import { WorktreePool, type LeaseRow } from '../../externals/worktree/index.js';

/** The pool's leases for one clone; `undefined` when the pool cannot be read. */
export type LeasesOf = (clone: string) => readonly LeaseRow[] | undefined;

/**
 * Each clone's pool leases, asked at most once per returned function. A pool
 * that cannot be read, or a `read` that throws, is `undefined`, never a throw.
 *
 * @param read how one clone's leases are read; the real pool by default.
 */
export function poolLeases(read: (clone: string) => readonly LeaseRow[] = (c) => new WorktreePool(c).status()): LeasesOf {
  const cache = new Map<string, readonly LeaseRow[] | undefined>();
  return (clone) => {
    if (!cache.has(clone)) {
      try {
        cache.set(clone, read(clone));
      } catch {
        cache.set(clone, undefined);
      }
    }
    return cache.get(clone);
  };
}
