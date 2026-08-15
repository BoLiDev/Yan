import * as git from '../../util/git.js';
import { WorktreeError } from './errors.js';
import { pathKey } from './layout.js';

/** What the pool asks git. Reads only; nothing here writes. */

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
 * Which working tree has `branch` checked out, if any. The main clone counts,
 * so the answer can be a directory the pool does not own.
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
 * The ref `base` names: a local branch first, then `origin/<base>`, then
 * anything git can resolve. Never fetches, so the answer is only as fresh as
 * the clone.
 *
 * @throws WorktreeError when nothing resolves.
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
