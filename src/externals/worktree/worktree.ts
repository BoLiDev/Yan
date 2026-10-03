import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as git from '../../util/git.js';
import { withLock } from '../../util/lock.js';
import { baseRef, isRegisteredWorktree, worktreesOnBranch } from './git-facts.js';
import { assertReturnable, wipe } from './guard.js';
import { absolute, cloneDir, leaseFile, leasesDir, lockFile, poolRoot, repoName, slotTree } from './layout.js';
import { allLeases, newLeaseId, reclaim, releaseLease, writeLease } from './lease.js';
import type { LeaseGrant, LeaseRow } from './types.js';
import { YanError } from '../../util/error.js';
import { isDirectory, samePath } from '../../util/paths.js';

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
   * Lease a tree to `holder` on a detached HEAD at `base`, or on `branch`
   * when one is given. The pool names no branch of its own: how a branch is
   * named differs from one machine to the next, so the agent working in the
   * tree cuts its own, and `branch` is one it cut before. Waits up to
   * `$YAN_POOL_LOCK_TIMEOUT` seconds (60 by default) for the pool lock.
   *
   * @throws YanError `worktree_usage` for a missing argument or a holder
   *   carrying whitespace, `worktree_failed` when the tree cannot be placed,
   *   `worktree_branch` when it cannot be put on `branch`; no lease is
   *   written then, so the caller may ask again without one.
   */
  public get(base: string, holder: string, options: { branch?: string } = {}): LeaseGrant {
    if (!base) throw YanError.usage('worktree_usage', 'a base ref is required - a tree is always cut from an explicit base');
    if (!holder) throw YanError.usage('worktree_usage', 'a holder is required');
    if (/\s/.test(holder)) throw YanError.usage('worktree_usage', 'a holder may not contain whitespace');

    mkdirSync(leasesDir(this.dir), { recursive: true });
    return withLock(lockFile(this.dir), lockTimeoutSeconds(), () => this.getLocked(base, holder, options.branch));
  }

  private getLocked(base: string, holder: string, branch: string | undefined): LeaseGrant {
    const name = repoName(absolute(this.clone));

    git.worktreePrune(this.clone);
    reclaim(this.dir);
    this.detachFreeSlots(name);

    const slot = this.pickSlot(name);
    const tree = slotTree(this.dir, slot, name);
    mkdirSync(join(this.dir, String(slot)), { recursive: true });
    this.placeTree(tree, slot, base);
    if (branch !== undefined && branch !== '') putOnBranch(this.clone, tree, branch);

    const leaseId = newLeaseId();
    writeLease(this.dir, slot, { path: tree, base, holder, leaseId });
    return { path: tree, lease_id: leaseId, holder };
  }

  /** The slot numbers this pool has a directory for, lowest first. */
  private slots(): number[] {
    return readdirSync(this.dir).filter((e) => /^[0-9]+$/.test(e)).map(Number).sort((a, b) => a - b);
  }

  /**
   * Take every free slot still on a branch off it. Returning a tree detaches
   * it, but one returned by a yan from before that stays on the branch it
   * worked on, and holds it, until this runs. Best effort: a slot left on
   * its branch is no worse than it was.
   */
  private detachFreeSlots(name: string): void {
    const onBranch = worktreesOnBranch(this.clone);
    for (const n of this.slots()) {
      if (existsSync(leaseFile(this.dir, n))) continue;
      const tree = slotTree(this.dir, n, name);
      if (onBranch.some((w) => samePath(w.path, tree))) git.detach(tree);
    }
  }

  /**
   * The lowest free slot that already holds a tree, so the pool reuses a warm
   * one before it cuts a new one; otherwise the lowest slot with no tree in it.
   * A slot whose directory holds something git did not put there is skipped.
   */
  private pickSlot(name: string): number {
    const free = (n: number): boolean => !existsSync(leaseFile(this.dir, n));
    const warm = this.slots().find((n) => free(n) && existsSync(join(this.dir, String(n), name, '.git')));
    if (warm !== undefined) return warm;
    for (let n = 1; ; n += 1) {
      if (free(n) && !existsSync(join(this.dir, String(n), name))) return n;
    }
  }

  private placeTree(tree: string, slot: number, base: string): void {
    const ref = baseRef(this.clone, base);

    if (isRegisteredWorktree(this.clone, tree)) {
      if (!git.isClean(tree)) {
        throw new YanError('worktree_failed',
          `the tree in slot ${slot} still has changes: ${tree} - it was not returned properly, so look at it before it is leased again`,
        );
      }
      const checkout = git.checkout(tree, ['--detach', ref]);
      if (checkout.code !== 0) throw new YanError('worktree_failed', `cannot put ${tree} at '${ref}': ${checkout.stderr.trim()}`);
      return;
    }

    if (existsSync(tree)) {
      throw new YanError('worktree_failed',
        `${tree} exists but git does not know it as a worktree - move it aside; the pool never deletes a directory it cannot account for`,
      );
    }
    const added = git.worktreeAdd(this.clone, ['--detach', tree, ref]);
    if (added.code !== 0) throw new YanError('worktree_failed', `cannot add a worktree at ${tree} at '${ref}': ${added.stderr.trim()}`);
  }
}

/**
 * Put a tree just placed on `branch`: the clone's own branch of that name,
 * brought up to origin's when it is only behind it, so nothing here is lost;
 * otherwise a new one tracking origin's. The name is the task's, never the
 * pool's.
 *
 * @throws YanError `worktree_branch` when neither the clone nor origin has
 *   it, or git refuses, as it does for a branch checked out in another tree.
 */
function putOnBranch(clone: string, tree: string, branch: string): void {
  const remote = `origin/${branch}`;
  const onOrigin = git.gitOk(clone, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}^{commit}`]);
  const local = git.branchExists(clone, branch);
  if (!local && !onOrigin) throw new YanError('worktree_branch', `there is no branch ${branch} here or on origin`);

  const checkout = git.checkout(tree, local ? [branch] : ['-b', branch, '--track', remote]);
  if (checkout.code !== 0) {
    throw new YanError('worktree_branch', `cannot put the tree on ${branch}: ${checkout.stderr.trim().split(/\r?\n/)[0] ?? ''}`);
  }
  // Another machine may have pushed to it since. A branch that has gone its
  // own way here is left as it is: the agent sees it, and merging is its call.
  if (local && onOrigin) git.git(tree, ['merge', '--ff-only', '--quiet', remote]);
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
      held.push({ slot: lease.slot, path: lease.path, base: lease.base, holder: lease.holder, lease_id: lease.lease_id, at: lease.at });
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
