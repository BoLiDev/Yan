import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { YanError, usageError } from '../../util/error.js';
import * as git from '../../util/git.js';
import { writeJson } from '../../util/json.js';
import { withLock } from '../../util/lock.js';
import { normalizePath, samePath } from '../../util/paths.js';

/**
 * The worktree pool (worktree.md §7, architecture.md §4.3).
 *
 * The pool exists for exactly one reason: warm reuse. On a large monorepo a
 * handful of trees stay ready, and whichever one you lease needs no cold
 * install. Everything else here — leases, backpressure, the orphan-commit
 * guard — is the price of that one property, and the property itself is one
 * letter wide:
 *
 *   RETURNING A TREE IS `git reset --hard` PLUS `git clean -fd`.
 *   NEVER WITH -x.
 *
 * -x would delete the gitignored node_modules and build caches too, which
 * turns every lease back into a cold install and nothing fails loudly when it
 * happens. That is why the clean goes through `util/git.ts`'s `cleanFd`, which
 * hardcodes the flags, instead of being spelled out here.
 *
 * Layout (td INDEX.md §3):
 *
 *   <pool root>/<repo>-<hash>/
 *     leases/<slot>.json     the runtime records — they belong to the pool,
 *                            NOT to a task, so they never live under $YAN_HOME
 *     <slot>/<repo>/         the tree itself
 *
 * The pool root is ~/.yan-trees by default and $YAN_POOL_ROOT overrides it.
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
 * same slot. That was tried first. It is **not sufficient**, because the work
 * a lease protects is not only the slot — `git worktree add` writes the SHARED
 * clone's `.git/config` to record the upstream branch, and two of them against
 * one repository collide on git's own config lock:
 *
 *   error: could not lock config file .git/config: File exists
 *   error: unable to write upstream branch configuration
 *
 * So the critical section is "one git worktree operation per clone at a time",
 * which is what `lib-pool.sh`'s lock was really buying. It is kept, ported onto
 * `util/lock.ts`'s `fs.open(…, 'wx')` primitive rather than the mkdir scheme —
 * one primitive, two callers, no third scheme invented.
 *
 * `poolReturn` and `poolStatus` take no lock: return is identified by the lease
 * it releases and touches only that tree, and status should never block on
 * whoever is busy creating a worktree.
 *
 * WHAT THIS IS NOT. A seam reports facts and decides nothing: `poolGet` hands
 * out a tree or says the pool is full, and the subcommand decides what that
 * means. It calls `util/git.ts` (a stateless utility — a normal downward
 * dependency) and never another seam. There is no force flag anywhere:
 * boundaries.md §9.2 forbids it, and the orphan-commit guard is the last line
 * of defence, so a refusal means stop and investigate.
 */

export const POOL_USAGE = 'pool_usage';
export const POOL_FULL = 'pool_full';
export const POOL_FAILED = 'pool_failed';
/**
 * The identity check refused the return. Nothing was touched.
 *
 * Its own code on purpose: an automatic retry has to tell "someone else holds
 * this tree now" apart from "the return failed", and that distinction is the
 * whole point of `--if-lease-id`.
 */
export const POOL_MISMATCH = 'pool_mismatch';
export const POOL_MISMATCH_EXIT = 3;

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

export interface LeaseGrant {
  readonly path: string;
  readonly lease_id: string;
  readonly holder: string;
}

// --- paths -----------------------------------------------------------------

function absolute(path: string): string {
  return normalizePath(resolve(path));
}

/** Not a security boundary: it only keeps two clones with the same basename in different pools. */
function shortHash(text: string, length = 8): string {
  return createHash('sha1').update(text).digest('hex').slice(0, length);
}

function repoName(clone: string): string {
  return basename(normalizePath(clone).replace(/\/+$/, '')).replace(/\.git$/, '');
}

/**
 * The comparable form of a path. Purely lexical, so it works for paths that do
 * not exist yet. `samePath` already lower-cases on Windows only, because two
 * spellings that differ in case are the same directory there and the same
 * comparison would be wrong on Linux.
 */
function pathKey(path: string): string {
  const n = normalizePath(path);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

export function poolRoot(): string {
  const root = process.env.YAN_POOL_ROOT ?? join(homedir(), '.yan-trees');
  try {
    mkdirSync(root, { recursive: true });
  } catch (cause) {
    throw new YanError(
      POOL_FAILED,
      `cannot create the pool root: ${root} - set YAN_POOL_ROOT to a writable directory`,
      { cause },
    );
  }
  return absolute(root);
}

/** This clone's pool: `<root>/<repo>-<hash>`. */
export function poolDir(clone: string): string {
  if (!clone) throw usageError(POOL_USAGE, 'a main clone directory is required');
  const abs = absolute(clone);
  return `${poolRoot()}/${repoName(abs)}-${shortHash(pathKey(abs))}`;
}

function leasesDir(dir: string): string {
  return join(dir, 'leases');
}

function leaseFile(dir: string, slot: number): string {
  return join(leasesDir(dir), `${slot}.json`);
}

// --- leases ----------------------------------------------------------------

function readLease(file: string): Lease | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as Lease;
  } catch {
    return undefined;
  }
}

function allLeases(dir: string): Lease[] {
  let names: string[];
  try {
    names = readdirSync(leasesDir(dir));
  } catch {
    return [];
  }
  const leases: Lease[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const lease = readLease(join(leasesDir(dir), name));
    if (lease !== undefined) leases.push(lease);
  }
  return leases.sort((a, b) => a.slot - b.slot);
}

/**
 * Drop leases whose tree no longer exists.
 *
 * Only that case. A lease whose owning process died is NOT reclaimed: the tree
 * may still hold work, and "no process is running but this tree is still taken"
 * is precisely what a lease is for (worktree.md §7).
 */
function reclaim(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(leasesDir(dir));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(leasesDir(dir), name);
    const path = readLease(file)?.path ?? '';
    if (path === '' || !existsSync(path)) rmSync(file, { force: true });
  }
}

function leaseIdFor(): string {
  return randomBytes(8).toString('hex');
}

// --- git facts -------------------------------------------------------------

/** Zero when git knows `path` as a worktree of `clone`. */
function isRegisteredWorktree(clone: string, path: string): boolean {
  let porcelain: string;
  try {
    porcelain = git.worktreeList(clone);
  } catch {
    return false;
  }
  const want = pathKey(path);
  return porcelain
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .some((l) => pathKey(l.slice('worktree '.length)) === want);
}

/**
 * The ref a new shift branch is cut from.
 *
 * A local branch wins, then origin/<base>, then anything git can resolve. The
 * pool never fetches: keeping the integration branch up to date is `yan sync`'s
 * job, and a seam does not decide when to talk to the remote.
 */
function baseRef(clone: string, base: string): string {
  if (git.branchExists(clone, base)) return base;
  if (git.gitOk(clone, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])) {
    return `origin/${base}`;
  }
  if (git.gitOk(clone, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) return base;
  throw new YanError(
    POOL_FAILED,
    `cannot resolve the base '${base}' in ${clone} - fetch it first, or pass a base that exists`,
  );
}

// --- get -------------------------------------------------------------------

function lockTimeoutSeconds(): number {
  const raw = process.env.YAN_POOL_LOCK_TIMEOUT ?? '';
  return /^[0-9]+$/.test(raw) ? Number(raw) : 60;
}

/**
 * Lease a tree, cut `branch` from `base` in it, and return
 * `{path, lease_id, holder}`.
 *
 * The pool size is passed in rather than read here: it lives in
 * mem/repos.json, which is yan's own bookkeeping, and a seam does not read (or
 * write) that.
 */
export function poolGet(
  clone: string,
  size: number,
  base: string,
  branch: string,
  holder: string,
): LeaseGrant {
  if (!clone) throw usageError(POOL_USAGE, 'a main clone directory is required');
  if (!Number.isInteger(size) || size <= 0) {
    throw usageError(POOL_USAGE, `the pool size must be a positive whole number, got: ${size}`);
  }
  if (!base) {
    throw usageError(POOL_USAGE, 'a base ref is required - a tree is always cut from an explicit base');
  }
  if (!branch) {
    throw usageError(
      POOL_USAGE,
      'a branch name is required - a leased tree is never left on a detached HEAD',
    );
  }
  if (!holder) {
    throw usageError(POOL_USAGE, 'a holder is required, in the form <task>/<unit>/<sid>');
  }
  if (/\s/.test(`${branch}${holder}`)) {
    throw usageError(POOL_USAGE, 'a branch name and a holder may not contain whitespace');
  }
  let isDir = false;
  try {
    isDir = statSync(clone).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw usageError(POOL_USAGE, `not a directory: ${clone}`);

  const dir = poolDir(clone);
  mkdirSync(leasesDir(dir), { recursive: true });

  return withLock(join(dir, 'lock'), lockTimeoutSeconds(), () =>
    getLocked(clone, size, base, branch, holder, dir),
  );
}

function getLocked(
  clone: string,
  size: number,
  base: string,
  branch: string,
  holder: string,
  dir: string,
): LeaseGrant {
  const name = repoName(absolute(clone));

  // A tree somebody deleted by hand leaves an administrative record behind that
  // would make `worktree add` refuse the path. Pruning removes only records
  // whose directory is already gone.
  git.worktreePrune(clone);
  reclaim(dir);

  // A slot that already holds a tree first: that is warm reuse. Only if none is
  // free do we take an empty one.
  let slot: number | undefined;
  const cold: number[] = [];
  for (let n = 1; n <= size; n += 1) {
    if (existsSync(leaseFile(dir, n))) continue;
    if (existsSync(join(dir, String(n), name, '.git'))) {
      slot = n;
      break;
    }
    if (!existsSync(join(dir, String(n), name))) cold.push(n);
  }
  slot ??= cold[0];

  if (slot === undefined) {
    // Backpressure. A full pool fails instead of growing: an extra tree would
    // be a cold one, which is the same as having no pool (worktree.md §7).
    throw new YanError(
      POOL_FULL,
      `the pool is full - all ${size} trees are leased, cannot start a new shift. 'yan tree status' shows who holds them; raise pool_size in mem/repos.json only if this machine can afford another tree`,
    );
  }

  const tree = normalizePath(join(dir, String(slot), name));
  {
    mkdirSync(join(dir, String(slot)), { recursive: true });
    const ref = baseRef(clone, base);

    if (isRegisteredWorktree(clone, tree)) {
      if (!git.isClean(tree)) {
        throw new YanError(
          POOL_FAILED,
          `the tree in slot ${slot} still has changes: ${tree} - it was not returned properly, so investigate before it is leased again`,
        );
      }
      const checkout = git.branchExists(clone, branch)
        ? git.checkout(tree, [branch])
        : git.checkout(tree, ['-b', branch, ref]);
      if (checkout.code !== 0) {
        throw new YanError(
          POOL_FAILED,
          `cannot put ${tree} on '${branch}': ${checkout.stderr.trim()}`,
        );
      }
    } else {
      if (existsSync(tree)) {
        throw new YanError(
          POOL_FAILED,
          `${tree} exists but git does not know it as a worktree - move it aside; the pool never deletes a directory it cannot account for`,
        );
      }
      const added = git.branchExists(clone, branch)
        ? git.worktreeAdd(clone, [tree, branch])
        : git.worktreeAdd(clone, ['-b', branch, tree, ref]);
      if (added.code !== 0) {
        throw new YanError(
          POOL_FAILED,
          `cannot add a worktree at ${tree} on '${branch}': ${added.stderr.trim()}`,
        );
      }
    }

    // The tree must end up on a real branch. treehouse keeps a detached HEAD
    // and calls it a feature; yan's shift branches have to be pushed and turned
    // into MRs, so a detached HEAD here is a bug, not a state (worktree.md §7).
    let current = '';
    try {
      current = git.currentBranch(tree);
    } catch {
      current = '';
    }
    if (current !== branch) {
      throw new YanError(
        POOL_FAILED,
        `the tree is on '${current === '' ? 'an unknown ref' : current}', not '${branch}' - refusing to hand out a tree that is not on its shift branch`,
      );
    }

    const leaseId = leaseIdFor();
    // The same shape and key order as the shell implementation writes, so both
    // halves can read each other's leases for the length of the migration.
    writeJson(leaseFile(dir, slot), {
      version: 1,
      slot,
      path: tree,
      branch,
      base,
      holder,
      lease_id: leaseId,
      at: Math.floor(Date.now() / 1000),
      pid: process.pid,
    });

    return { path: tree, lease_id: leaseId, holder };
  }
}

// --- return ----------------------------------------------------------------

function slotOf(dir: string, target: string): number | undefined {
  if (target === '') return undefined;
  if (/^[0-9]+$/.test(target)) {
    const slot = Number(target);
    return existsSync(leaseFile(dir, slot)) ? slot : undefined;
  }
  const want = pathKey(target);
  const wantAbs = pathKey(absolute(target));
  for (const lease of allLeases(dir)) {
    if (lease.path === undefined) continue;
    if (pathKey(lease.path) === want || pathKey(absolute(lease.path)) === wantAbs) return lease.slot;
  }
  return undefined;
}

/**
 * Reset and clean a tree, then release its lease. Returns the path it returned.
 *
 * An undefined expectation means "do not compare that field".
 */
export function poolReturn(
  clone: string,
  target: string,
  expectLeaseId?: string,
  expectHolder?: string,
): string {
  if (!clone) throw usageError(POOL_USAGE, 'a main clone directory is required');
  if (!target) {
    throw usageError(
      POOL_USAGE,
      "which tree? pass the path 'yan tree get' printed, or its slot number",
    );
  }
  let isDir = false;
  try {
    isDir = statSync(clone).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw usageError(POOL_USAGE, `not a directory: ${clone}`);

  const dir = poolDir(clone);
  const slot = slotOf(dir, target);
  if (slot === undefined) {
    throw new YanError(
      POOL_FAILED,
      `no lease matches '${target}' - 'yan tree status' lists what the pool is holding`,
    );
  }

  const file = leaseFile(dir, slot);
  const lease = readLease(file);
  const haveId = lease?.lease_id ?? '';
  const haveHolder = lease?.holder ?? '';
  const tree = lease?.path ?? '';

  // Identity is compared BEFORE anything destructive happens — no reset, no
  // clean, no lease cleared. That is what makes an automatic retry safe.
  if (expectLeaseId !== undefined && expectLeaseId !== '' && expectLeaseId !== haveId) {
    throw new YanError(
      POOL_MISMATCH,
      `lease id does not match: slot ${slot} is held under '${haveId}', not '${expectLeaseId}' - nothing was touched`,
      { exitCode: POOL_MISMATCH_EXIT },
    );
  }
  if (expectHolder !== undefined && expectHolder !== '' && expectHolder !== haveHolder) {
    throw new YanError(
      POOL_MISMATCH,
      `holder does not match: slot ${slot} is held by '${haveHolder}', not '${expectHolder}' - nothing was touched`,
      { exitCode: POOL_MISMATCH_EXIT },
    );
  }

  if (tree === '' || !existsSync(tree)) {
    process.stderr.write(
      `lib-pool: the leased tree is gone: ${tree === '' ? '<unknown>' : tree} - releasing the lease on slot ${slot}\n`,
    );
    rmSync(file, { force: true });
    return tree;
  }

  // The orphan-commit guard. Returning destroys what is in the tree, so there
  // is exactly one question: would that lose anything? Two commands answer it
  // (worktree.md §7), and a refusal means stop and investigate — there is
  // deliberately no way to override it.
  if (git.statusPorcelain(tree).trim() !== '') {
    throw new YanError(
      POOL_FAILED,
      `refusing to return ${tree}: it has uncommitted changes and returning it would destroy them permanently - commit and push them first`,
    );
  }
  let contained: string[] = [];
  try {
    contained = git.branchesContainingHead(tree);
  } catch {
    contained = [];
  }
  if (contained.filter((l) => l.trim() !== '').length === 0) {
    throw new YanError(
      POOL_FAILED,
      `refusing to return ${tree}: no remote branch contains HEAD, so these commits exist nowhere else - push the branch first`,
    );
  }

  if (git.resetHard(tree).code !== 0) throw new YanError(POOL_FAILED, `cannot reset ${tree}`);
  // -fd and never -x: gitignored dependencies and build caches survive from one
  // shift to the next. `cleanFd` hardcodes the flags.
  if (git.cleanFd(tree).code !== 0) throw new YanError(POOL_FAILED, `cannot clean ${tree}`);

  rmSync(file, { force: true });
  return tree;
}

// --- status ----------------------------------------------------------------

/**
 * The leases, sorted by slot.
 *
 * Every lease file is written through `util/json.ts`'s tmp → rename, so a
 * reader never sees a half-written record, and status should never block on
 * whoever is busy creating a worktree.
 */
export function poolStatus(clone: string): Array<Omit<Lease, 'version' | 'pid'>> {
  if (!clone) throw usageError(POOL_USAGE, 'a main clone directory is required');
  let isDir = false;
  try {
    isDir = statSync(clone).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw usageError(POOL_USAGE, `not a directory: ${clone}`);

  return allLeases(poolDir(clone)).map((l) => ({
    slot: l.slot,
    path: l.path,
    branch: l.branch,
    base: l.base,
    holder: l.holder,
    lease_id: l.lease_id,
    at: l.at,
  }));
}

/** True when two paths name the same tree. Exported for the subcommand layer. */
export function sameTree(a: string, b: string): boolean {
  return samePath(a, b);
}
