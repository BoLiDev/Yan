import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { YanError, usageError } from '../../util/error.js';
import * as git from '../../util/git.js';
import { withLock } from '../../util/lock.js';
import {
  WORKTREE_FAILED,
  WORKTREE_FULL,
  WORKTREE_MISMATCH,
  WORKTREE_MISMATCH_EXIT,
  WORKTREE_USAGE,
} from './errors.js';
import { baseRef, isRegisteredWorktree } from './git-facts.js';
import { assertReturnable, wipe } from './guard.js';
import { absolute, cloneDir, leaseFile, leasesDir, lockFile, repoName, slotTree } from './layout.js';
import { allLeases, newLeaseId, readLease, reclaim, releaseLease, slotOf, writeLease } from './lease.js';
import type { LeaseGrant, LeaseRow, ReturnExpectation } from './types.js';

/**
 * The worktree pool for one main clone (worktree.md §7, architecture.md §4.3).
 *
 * The pool exists for exactly one reason: warm reuse. On a large monorepo a
 * handful of trees stay ready, and whichever one you lease needs no cold
 * install. Everything else — leases, backpressure, the orphan-commit guard —
 * is the price of that one property.
 *
 * WHAT THIS IS NOT. It reports facts and decides nothing: `get` hands out a
 * tree or says the pool is full, and the subcommand decides what that means. It
 * calls `util/git.ts` (a stateless utility — a normal downward dependency) and
 * never another external. There is no force flag anywhere.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS STILL TAKES A LOCK
 * ---------------------------------------------------------------------------
 *
 * plan/conventions.md §4 says the only remaining lock should be `yan wait`'s
 * single-flight. That is not achievable here, and the reason is worth recording
 * because it is not the obvious one.
 *
 * Slot allocation on its own needs no lock: `fs.open(leaseFile, 'wx')` is an
 * atomic exclusive create on both platforms, so two racers cannot claim the
 * same slot. That was tried first. It is **not sufficient**, because the work a
 * lease protects is not only the slot — `git worktree add` writes the SHARED
 * clone's `.git/config` to record the upstream branch, and two of them against
 * one repository collide on git's own config lock:
 *
 *   error: could not lock config file .git/config: File exists
 *
 * So the critical section is "one git worktree operation per clone at a time".
 * `return` and `status` take no lock: a return is identified by the lease it
 * releases and touches only that tree, and status should never block on whoever
 * is busy creating a worktree.
 */
export class WorktreePool {
  private readonly clone: string;
  private readonly dir: string;

  /**
   * @param clone the main clone this pool serves. Validated once, here, rather
   *   than at the top of all three methods.
   */
  public constructor(clone: string) {
    if (!clone) throw usageError(WORKTREE_USAGE, 'a main clone directory is required');
    let isDir = false;
    try {
      isDir = statSync(clone).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw usageError(WORKTREE_USAGE, `not a directory: ${clone}`);

    this.clone = clone;
    this.dir = cloneDir(clone);
  }

  /**
   * Lease a tree and cut `branch` from `base` in it.
   *
   * The pool size is passed in rather than read here: it lives in
   * mem/repos.json, which is yan's own bookkeeping, and this module does not
   * read (or write) that.
   */
  public get(size: number, base: string, branch: string, holder: string): LeaseGrant {
    if (!Number.isInteger(size) || size <= 0) {
      throw usageError(WORKTREE_USAGE, `the pool size must be a positive whole number, got: ${size}`);
    }
    if (!base) {
      throw usageError(
        WORKTREE_USAGE,
        'a base ref is required - a tree is always cut from an explicit base',
      );
    }
    if (!branch) {
      throw usageError(
        WORKTREE_USAGE,
        'a branch name is required - a leased tree is never left on a detached HEAD',
      );
    }
    if (!holder) {
      throw usageError(WORKTREE_USAGE, 'a holder is required, in the form <task>/<unit>/<sid>');
    }
    if (/\s/.test(`${branch}${holder}`)) {
      throw usageError(WORKTREE_USAGE, 'a branch name and a holder may not contain whitespace');
    }

    mkdirSync(leasesDir(this.dir), { recursive: true });
    return withLock(lockFile(this.dir), lockTimeoutSeconds(), () =>
      this.getLocked(size, base, branch, holder),
    );
  }

  /**
   * Reset and clean a tree, then release its lease. Returns the path it
   * returned.
   *
   * `expect` is compared BEFORE anything destructive happens — no reset, no
   * clean, no lease cleared. That is what makes an automatic retry safe. An
   * absent field is not compared.
   */
  public return(target: string, expect: ReturnExpectation = {}): string {
    if (!target) {
      throw usageError(
        WORKTREE_USAGE,
        "which tree? pass the path 'yan tree get' printed, or its slot number",
      );
    }

    const slot = slotOf(this.dir, target);
    if (slot === undefined) {
      throw new YanError(
        WORKTREE_FAILED,
        `no lease matches '${target}' - 'yan tree status' lists what the pool is holding`,
      );
    }

    const lease = readLease(leaseFile(this.dir, slot));
    const haveId = lease?.lease_id ?? '';
    const haveHolder = lease?.holder ?? '';
    const tree = lease?.path ?? '';

    if (expect.leaseId !== undefined && expect.leaseId !== '' && expect.leaseId !== haveId) {
      throw new YanError(
        WORKTREE_MISMATCH,
        `lease id does not match: slot ${slot} is held under '${haveId}', not '${expect.leaseId}' - nothing was touched`,
        { exitCode: WORKTREE_MISMATCH_EXIT },
      );
    }
    if (expect.holder !== undefined && expect.holder !== '' && expect.holder !== haveHolder) {
      throw new YanError(
        WORKTREE_MISMATCH,
        `holder does not match: slot ${slot} is held by '${haveHolder}', not '${expect.holder}' - nothing was touched`,
        { exitCode: WORKTREE_MISMATCH_EXIT },
      );
    }

    if (tree === '' || !existsSync(tree)) {
      process.stderr.write(
        `worktree: the leased tree is gone: ${tree === '' ? '<unknown>' : tree} - releasing the lease on slot ${slot}\n`,
      );
      releaseLease(this.dir, slot);
      return tree;
    }

    assertReturnable(tree);
    wipe(tree);
    releaseLease(this.dir, slot);
    return tree;
  }

  /** The leases, sorted by slot. */
  public status(): LeaseRow[] {
    return allLeases(this.dir).map((l) => ({
      slot: l.slot,
      path: l.path,
      branch: l.branch,
      base: l.base,
      holder: l.holder,
      lease_id: l.lease_id,
      at: l.at,
    }));
  }

  private getLocked(size: number, base: string, branch: string, holder: string): LeaseGrant {
    const name = repoName(absolute(this.clone));

    // A tree somebody deleted by hand leaves an administrative record behind
    // that would make `worktree add` refuse the path. Pruning removes only
    // records whose directory is already gone.
    git.worktreePrune(this.clone);
    reclaim(this.dir);

    const slot = this.pickSlot(size, name);
    if (slot === undefined) {
      // Backpressure. A full pool fails instead of growing: an extra tree would
      // be a cold one, which is the same as having no pool (worktree.md §7).
      throw new YanError(
        WORKTREE_FULL,
        `the pool is full - all ${size} trees are leased, cannot start a new shift. 'yan tree status' shows who holds them; raise pool_size in mem/repos.json only if this machine can afford another tree`,
      );
    }

    const tree = slotTree(this.dir, slot, name);
    mkdirSync(join(this.dir, String(slot)), { recursive: true });
    this.placeTree(tree, slot, base, branch);
    this.assertOnBranch(tree, branch);

    const leaseId = newLeaseId();
    writeLease(this.dir, slot, { path: tree, branch, base, holder, leaseId });
    return { path: tree, lease_id: leaseId, holder };
  }

  /**
   * A slot that already holds a tree first: that is warm reuse. Only if none is
   * free do we take an empty one.
   */
  private pickSlot(size: number, name: string): number | undefined {
    const cold: number[] = [];
    for (let n = 1; n <= size; n += 1) {
      if (existsSync(leaseFile(this.dir, n))) continue;
      if (existsSync(join(this.dir, String(n), name, '.git'))) return n;
      if (!existsSync(join(this.dir, String(n), name))) cold.push(n);
    }
    return cold[0];
  }

  private placeTree(tree: string, slot: number, base: string, branch: string): void {
    const ref = baseRef(this.clone, base);

    if (isRegisteredWorktree(this.clone, tree)) {
      if (!git.isClean(tree)) {
        throw new YanError(
          WORKTREE_FAILED,
          `the tree in slot ${slot} still has changes: ${tree} - it was not returned properly, so investigate before it is leased again`,
        );
      }
      const checkout = git.branchExists(this.clone, branch)
        ? git.checkout(tree, [branch])
        : git.checkout(tree, ['-b', branch, ref]);
      if (checkout.code !== 0) {
        throw new YanError(WORKTREE_FAILED, `cannot put ${tree} on '${branch}': ${checkout.stderr.trim()}`);
      }
      return;
    }

    if (existsSync(tree)) {
      throw new YanError(
        WORKTREE_FAILED,
        `${tree} exists but git does not know it as a worktree - move it aside; the pool never deletes a directory it cannot account for`,
      );
    }
    const added = git.branchExists(this.clone, branch)
      ? git.worktreeAdd(this.clone, [tree, branch])
      : git.worktreeAdd(this.clone, ['-b', branch, tree, ref]);
    if (added.code !== 0) {
      throw new YanError(
        WORKTREE_FAILED,
        `cannot add a worktree at ${tree} on '${branch}': ${added.stderr.trim()}`,
      );
    }
  }

  /**
   * The tree must end up on a real branch. treehouse keeps a detached HEAD and
   * calls it a feature; yan's shift branches have to be pushed and turned into
   * MRs, so a detached HEAD here is a bug, not a state (worktree.md §7).
   */
  private assertOnBranch(tree: string, branch: string): void {
    let current = '';
    try {
      current = git.currentBranch(tree);
    } catch {
      current = '';
    }
    if (current !== branch) {
      throw new YanError(
        WORKTREE_FAILED,
        `the tree is on '${current === '' ? 'an unknown ref' : current}', not '${branch}' - refusing to hand out a tree that is not on its shift branch`,
      );
    }
  }
}

function lockTimeoutSeconds(): number {
  const raw = process.env.YAN_POOL_LOCK_TIMEOUT ?? '';
  return /^[0-9]+$/.test(raw) ? Number(raw) : 60;
}
