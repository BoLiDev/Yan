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
