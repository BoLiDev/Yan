import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as git from '../../util/git.js';
import { withLock } from '../../util/lock.js';
import { WorktreeError } from './errors.js';
import { baseRef, isRegisteredWorktree, worktreeHolding } from './git-facts.js';
import { assertReturnable, wipe } from './guard.js';
import { absolute, cloneDir, leaseFile, leasesDir, lockFile, repoName, slotTree } from './layout.js';
import { allLeases, newLeaseId, readLease, reclaim, releaseLease, slotOf, writeLease } from './lease.js';
import type { LeaseGrant, LeaseRow, ReturnOptions } from './types.js';

/**
 * The worktree pool for one main clone.
 *
 * The pool exists for one reason: warm reuse. On a large monorepo a handful of
 * trees stay ready, so whichever one you lease needs no cold install.
 * Everything else here — leases, backpressure, the orphan-commit guard — is the
 * price of that single property.
 *
 * It reports facts and decides nothing. `get` hands out a tree or says the pool
 * is full; what that means is the caller's problem.
 *
 * Why `get` takes a lock, when an atomic create looks like enough.
 *
 * Slot allocation alone needs no lock: `fs.open(leaseFile, 'wx')` is an atomic
 * exclusive create on both platforms, so two racers cannot claim one slot.
 *
 * It is still not sufficient, because the slot is not the only shared thing.
 * `git worktree add` writes the shared clone's `.git/config` to record the
 * upstream branch, and two of those against one repository collide on git's own
 * config lock:
 *
 *   error: could not lock config file .git/config: File exists
 *
 * So the critical section is "one git worktree operation per clone at a time",
 * not "one slot allocation at a time".
 *
 * `return` and `status` take no lock, deliberately: a return is identified by
 * the lease it releases and touches only that one tree, and status must never
 * block behind whoever is busy creating a worktree.
 */
export class WorktreePool {
  private readonly clone: string;
  private readonly dir: string;

  /** @param clone the main clone this pool serves. Validated once, here. */
  public constructor(clone: string) {
    if (!clone) throw WorktreeError.usage('a main clone directory is required');
    let isDir = false;
    try {
      isDir = statSync(clone).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw WorktreeError.usage(`not a directory: ${clone}`);

    this.clone = clone;
    this.dir = cloneDir(clone);
  }

  /**
   * Lease a tree and cut `branch` from `base` in it.
   *
   * The pool size is a parameter rather than something this reads, because it
   * lives in mem/repos.json — yan's own bookkeeping, which this module is not
   * allowed to know about.
   */
  public get(size: number, base: string, branch: string, holder: string): LeaseGrant {
    if (!Number.isInteger(size) || size <= 0) {
      throw WorktreeError.usage(`the pool size must be a positive whole number, got: ${size}`);
    }
    if (!base) {
      throw WorktreeError.usage(
        'a base ref is required - a tree is always cut from an explicit base',
      );
    }
    if (!branch) {
      throw WorktreeError.usage(
        'a branch name is required - a leased tree is never left on a detached HEAD',
      );
    }
    if (!holder) {
      throw WorktreeError.usage('a holder is required, in the form <task>/<unit>/<sid>');
    }
    if (/\s/.test(`${branch}${holder}`)) {
      throw WorktreeError.usage('a branch name and a holder may not contain whitespace');
    }

    mkdirSync(leasesDir(this.dir), { recursive: true });
    return withLock(lockFile(this.dir), lockTimeoutSeconds(), () =>
      this.getLocked(size, base, branch, holder),
    );
  }

  /**
   * Reset and clean a tree, then release its lease. Returns the path.
   *
   * `expect` is compared before anything destructive happens — no reset, no
   * clean, no lease cleared — which is what makes an automatic retry safe. An
   * absent field is not compared.
   *
   * `expect.force` skips the orphan-commit guard and nothing else. The identity
   * check still runs: a forced return that lands on the wrong slot is the one
   * mistake force must not make, because the consent it carries was to discard
   * this tree's changes, not somebody else's.
   */
  public return(target: string, expect: ReturnOptions = {}): string {
    if (!target) {
      throw WorktreeError.usage(
        "which tree? pass the path 'yan tree get' printed, or its slot number",
      );
    }

    const slot = slotOf(this.dir, target);
    if (slot === undefined) {
      throw new WorktreeError(
        'failed',
        `no lease matches '${target}' - 'yan tree status' lists what the pool is holding`,
      );
    }

    const lease = readLease(leaseFile(this.dir, slot));
    const haveId = lease?.lease_id ?? '';
    const haveHolder = lease?.holder ?? '';
    const tree = lease?.path ?? '';

    if (expect.leaseId !== undefined && expect.leaseId !== '' && expect.leaseId !== haveId) {
      throw WorktreeError.mismatch(
        `lease id does not match: slot ${slot} is held under '${haveId}', not '${expect.leaseId}' - nothing was touched`,
      );
    }
    if (expect.holder !== undefined && expect.holder !== '' && expect.holder !== haveHolder) {
      throw WorktreeError.mismatch(
        `holder does not match: slot ${slot} is held by '${haveHolder}', not '${expect.holder}' - nothing was touched`,
      );
    }

    if (tree === '' || !existsSync(tree)) {
      process.stderr.write(
        `worktree: the leased tree is gone: ${tree === '' ? '<unknown>' : tree} - releasing the lease on slot ${slot}\n`,
      );
      releaseLease(this.dir, slot);
      return tree;
    }

    if (expect.force !== true) assertReturnable(tree);
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
      // Backpressure: a full pool fails instead of growing. An extra tree would
      // be a cold one, and a cold tree is the same as having no pool at all.
      throw new WorktreeError(
        'full',
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

  /** A slot that already holds a tree wins — that is the warm reuse. An empty slot is the fallback. */
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
        throw new WorktreeError(
          'failed',
          `the tree in slot ${slot} still has changes: ${tree} - it was not returned properly, so investigate before it is leased again`,
        );
      }
      const checkout = git.branchExists(this.clone, branch)
        ? git.checkout(tree, [branch])
        : git.checkout(tree, ['-b', branch, ref]);
      if (checkout.code !== 0) {
        this.reportOccupied(branch, checkout.stderr);
        throw new WorktreeError('failed', `cannot put ${tree} on '${branch}': ${checkout.stderr.trim()}`);
      }
      return;
    }

    if (existsSync(tree)) {
      throw new WorktreeError(
        'failed',
        `${tree} exists but git does not know it as a worktree - move it aside; the pool never deletes a directory it cannot account for`,
      );
    }
    const added = git.branchExists(this.clone, branch)
      ? git.worktreeAdd(this.clone, [tree, branch])
      : git.worktreeAdd(this.clone, ['-b', branch, tree, ref]);
    if (added.code !== 0) {
      this.reportOccupied(branch, added.stderr);
      throw new WorktreeError(
        'failed',
        `cannot add a worktree at ${tree} on '${branch}': ${added.stderr.trim()}`,
      );
    }
  }

  /**
   * Turn git's "already used by worktree at …" into the sentence that says what
   * to do about it.
   *
   * git's own message is accurate and easy to read past; what it leaves out is
   * that the branch is very likely checked out in the clone the reader is
   * sitting in, and that the fix is one command there. The pool will not run
   * that command on their behalf: a tool that moves you off your branch to get
   * on with its own work is one you stop trusting.
   */
  private reportOccupied(branch: string, stderr: string): void {
    if (!/already (used by worktree|checked out)/i.test(stderr)) return;
    const holder = worktreeHolding(this.clone, branch);
    throw new WorktreeError(
      'failed',
      `'${branch}' is already checked out in ${holder ?? this.clone} - switch that clone to another branch and retry; the pool never moves a clone it does not own`,
    );
  }

  /**
   * The tree must end up on a real branch, never a detached HEAD. A shift's work
   * has to be pushed and turned into a merge request, so a detached HEAD is not
   * a state this can hand out and hope about — it is a bug that would surface
   * hours later, at the push.
   */
  private assertOnBranch(tree: string, branch: string): void {
    let current = '';
    try {
      current = git.currentBranch(tree);
    } catch {
      current = '';
    }
    if (current !== branch) {
      throw new WorktreeError(
        'failed',
        `the tree is on '${current === '' ? 'an unknown ref' : current}', not '${branch}' - refusing to hand out a tree that is not on its shift branch`,
      );
    }
  }
}

function lockTimeoutSeconds(): number {
  const raw = process.env.YAN_POOL_LOCK_TIMEOUT ?? '';
  return /^[0-9]+$/.test(raw) ? Number(raw) : 60;
}
