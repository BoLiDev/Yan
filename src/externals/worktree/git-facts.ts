import * as git from '../../util/git.js';
import { WorktreeError } from './errors.js';
import { pathKey } from './layout.js';

/**
 * Questions this module asks git. Facts only — nothing here decides anything,
 * and nothing here writes.
 */

/** True when git knows `path` as a worktree of `clone`. */
export function isRegisteredWorktree(clone: string, path: string): boolean {
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
 * Which working tree has `branch` checked out, if any.
 *
 * This became worth answering when the main clone stopped being yan's private
 * one (v3 td repos.md §3). Under `$YAN_HOME/repos/` nobody ever checked
 * anything out there, so "a branch cannot be checked out twice" was
 * structurally unreachable; now the registered clone is the one `user` works
 * in, and it is an ordinary Tuesday.
 *
 * `git worktree list --porcelain` lists the main clone first, so this finds it
 * as readily as it finds a leased tree — which is the point: the answer a
 * person needs is the directory to go and switch.
 */
export function worktreeHolding(clone: string, branch: string): string | undefined {
  let porcelain: string;
  try {
    porcelain = git.worktreeList(clone);
  } catch {
    return undefined;
  }
  let path = '';
  for (const raw of porcelain.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}` && path !== '') return path;
    else if (line === '') path = '';
  }
  return undefined;
}

/**
 * The ref a new shift branch is cut from.
 *
 * A local branch wins, then origin/<base>, then anything git can resolve. The
 * pool never fetches: keeping the integration branch up to date is `yan sync`'s
 * job, and this module does not decide when to talk to the remote.
 */
export function baseRef(clone: string, base: string): string {
  if (git.branchExists(clone, base)) return base;
  if (git.gitOk(clone, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`])) {
    return `origin/${base}`;
  }
  if (git.gitOk(clone, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) return base;
  throw new WorktreeError(
    'failed',
    `cannot resolve the base '${base}' in ${clone} - fetch it first, or pass a base that exists`,
  );
}
