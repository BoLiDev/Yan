import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as git from '../../util/git.js';
import { withLock } from '../../util/lock.js';
import { baseRef, isRegisteredWorktree, worktreeHolding } from './git-facts.js';
import { assertReturnable, wipe } from './guard.js';
import { absolute, cloneDir, leaseFile, leasesDir, lockFile, poolRoot, repoName, slotTree } from './layout.js';
import { allLeases, newLeaseId, reclaim, releaseLease, writeLease } from './lease.js';
import type { LeaseGrant, LeaseRow } from './types.js';
import { YanError } from '../../util/error.js';
import { isDirectory } from '../../util/paths.js';

/**
 * The worktree pool for one main clone: slots reused warm, so a leased tree
 * keeps the node_modules and build caches the last task left in it.
 *
 * A slot is never deleted. The pool grows by one whenever every slot is
 * leased, so its size is the most tasks this clone has had open at once.
 *
 * `get` serialises on a per-clone lock, because `git worktree add` writes the
 * shared clone's `.git/config` and two at once collide on git's config lock.
 */
export class WorktreePool {
  private readonly clone: string;
  private readonly dir: string;

  /** @throws YanError when `clone` is empty or not a directory. */
  public constructor(clone: string) {
    if (!clone) throw YanError.usage('worktree_usage', 'a main clone directory is required');
    if (!isDirectory(clone)) throw YanError.usage('worktree_usage', `not a directory: ${clone}`);
    this.clone = clone;
    this.dir = cloneDir(clone);
  }

  /**
   * Lease a tree to `holder` and put it on `branch`, cutting it from `base`
   * when it does not exist yet. Waits up to `$YAN_POOL_LOCK_TIMEOUT` seconds
   * (60 by default) for the pool lock.
   *
   * @throws YanError `worktree_usage` for a missing or whitespace-carrying
   *   argument, `worktree_failed` when the branch is checked out elsewhere or
   *   the tree cannot be placed.
   */
  public get(base: string, branch: string, holder: string): LeaseGrant {
    if (!base) throw YanError.usage('worktree_usage', 'a base ref is required - a tree is always cut from an explicit base');
    if (!branch) throw YanError.usage('worktree_usage', 'a branch name is required - a leased tree is never left on a detached HEAD');
    if (!holder) throw YanError.usage('worktree_usage', 'a holder is required');
    if (/\s/.test(`${branch}${holder}`)) throw YanError.usage('worktree_usage', 'a branch name and a holder may not contain whitespace');

    mkdirSync(leasesDir(this.dir), { recursive: true });
    return withLock(lockFile(this.dir), lockTimeoutSeconds(), () => this.getLocked(base, branch, holder));
  }

  private getLocked(base: string, branch: string, holder: string): LeaseGrant {
    const name = repoName(absolute(this.clone));

    git.worktreePrune(this.clone);
    reclaim(this.dir);

    const slot = this.pickSlot(name);
    const tree = slotTree(this.dir, slot, name);
    mkdirSync(join(this.dir, String(slot)), { recursive: true });
    this.placeTree(tree, slot, base, branch);
    this.assertOnBranch(tree, branch);

    const leaseId = newLeaseId();
    writeLease(this.dir, slot, { path: tree, branch, base, holder, leaseId });
    return { path: tree, lease_id: leaseId, holder };
  }

  /**
   * The lowest free slot that already holds a tree, so the pool reuses a warm
   * one before it cuts a new one; otherwise the lowest slot with no tree in it.
   * A slot whose directory holds something git did not put there is skipped.
   */
  private pickSlot(name: string): number {
    const free = (n: number): boolean => !existsSync(leaseFile(this.dir, n));
    const slots = readdirSync(this.dir).filter((e) => /^[0-9]+$/.test(e)).map(Number).sort((a, b) => a - b);
    const warm = slots.find((n) => free(n) && existsSync(join(this.dir, String(n), name, '.git')));
    if (warm !== undefined) return warm;
    for (let n = 1; ; n += 1) {
      if (free(n) && !existsSync(join(this.dir, String(n), name))) return n;
    }
  }

  private placeTree(tree: string, slot: number, base: string, branch: string): void {
    const ref = baseRef(this.clone, base);

    if (isRegisteredWorktree(this.clone, tree)) {
      if (!git.isClean(tree)) {
        throw new YanError('worktree_failed',
          `the tree in slot ${slot} still has changes: ${tree} - it was not returned properly, so look at it before it is leased again`,
        );
      }
      const checkout = git.branchExists(this.clone, branch)
        ? git.checkout(tree, [branch])
        : git.checkout(tree, ['-b', branch, ref]);
      if (checkout.code !== 0) {
        this.reportOccupied(branch, checkout.stderr);
        throw new YanError('worktree_failed', `cannot put ${tree} on '${branch}': ${checkout.stderr.trim()}`);
      }
      return;
    }

    if (existsSync(tree)) {
      throw new YanError('worktree_failed',
        `${tree} exists but git does not know it as a worktree - move it aside; the pool never deletes a directory it cannot account for`,
      );
    }
    const added = git.branchExists(this.clone, branch)
      ? git.worktreeAdd(this.clone, [tree, branch])
      : git.worktreeAdd(this.clone, ['-b', branch, tree, ref]);
    if (added.code !== 0) {
      this.reportOccupied(branch, added.stderr);
      throw new YanError('worktree_failed', `cannot add a worktree at ${tree} on '${branch}': ${added.stderr.trim()}`);
    }
  }

  /** Throws naming the clone that holds `branch` when git says it is checked out elsewhere. */
  private reportOccupied(branch: string, stderr: string): void {
    if (!/already (used by worktree|checked out)/i.test(stderr)) return;
    const holder = worktreeHolding(this.clone, branch);
    throw new YanError('worktree_failed',
      `'${branch}' is already checked out in ${holder ?? this.clone} - switch that clone to another branch and retry`,
    );
  }

  /** Throws unless the tree is on `branch`, so a detached HEAD is never handed out. */
  private assertOnBranch(tree: string, branch: string): void {
    let current = '';
    try {
      current = git.currentBranch(tree);
    } catch {
      current = '';
    }
    if (current !== branch) {
      throw new YanError('worktree_failed', `the tree is on '${current === '' ? 'an unknown ref' : current}', not '${branch}'`);
    }
  }
}

/** Every pool under the root: one directory per clone. */
function poolDirs(): string[] {
  const root = poolRoot();
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  return entries.map((e) => join(root, e)).filter((d) => isDirectory(join(d, 'leases')));
}

/**
 * The leases `holder` has, across every pool: one per repository it has a
 * tree of. A lease whose tree is gone does not count.
 */
export function leasesHeldBy(holder: string): LeaseRow[] {
  const held: LeaseRow[] = [];
  for (const dir of poolDirs()) {
    for (const lease of allLeases(dir)) {
      if (lease.holder !== holder || !existsSync(lease.path)) continue;
      held.push({ slot: lease.slot, path: lease.path, branch: lease.branch, base: lease.base, holder: lease.holder, lease_id: lease.lease_id, at: lease.at });
    }
  }
  return held;
}

/**
 * Give back every tree `holder` leased: refuse while any holds work that
 * exists nowhere else, unless `force`, before touching one; then reset and
 * clean each and release its lease. The slots stay, warm, for the next
 * lease. A tree already gone only has its lease released.
 *
 * @returns the trees' paths; none when `holder` held none.
 * @throws YanError `worktree_failed` when the guard refuses.
 */
export function returnTrees(holder: string, options: { force?: boolean } = {}): string[] {
  const held: Array<{ dir: string; slot: number; path: string }> = [];
  for (const dir of poolDirs()) {
    for (const lease of allLeases(dir)) {
      if (lease.holder === holder) held.push({ dir, slot: lease.slot, path: lease.path });
    }
  }
  if (options.force !== true) {
    for (const { path } of held) if (existsSync(path)) assertReturnable(path);
  }
  for (const { dir, slot, path } of held) {
    if (existsSync(path)) wipe(path);
    releaseLease(dir, slot);
  }
  return held.map((h) => h.path);
}

function lockTimeoutSeconds(): number {
  const raw = process.env.YAN_POOL_LOCK_TIMEOUT ?? '';
  return /^[0-9]+$/.test(raw) ? Number(raw) : 60;
}
