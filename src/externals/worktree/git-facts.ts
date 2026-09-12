import * as git from '../../util/git.js';
import { WorktreeError } from './errors.js';
import { pathKey } from './layout.js';

/** What the pool asks git. Reads only; nothing here writes. */

/** One entry of `git worktree list --porcelain`; `branch` is absent on a detached HEAD. */
interface Worktree {
  readonly path: string;
  readonly branch?: string;
}

/**
 * Every working tree git knows about for `clone`, the main clone included.
 * `[]` when git cannot be asked, so both callers below answer "no" rather than
 * throwing.
 */
function worktrees(clone: string): Worktree[] {
  let porcelain: string;
  try {
    porcelain = git.worktreeList(clone);
  } catch {
    return [];
  }

  // A blank line ends each entry, and `worktree <path>` opens the next one.
  const found: Worktree[] = [];
  let path = '';
  let branch: string | undefined;
  const close = (): void => {
    if (path !== '') found.push({ path, ...(branch === undefined ? {} : { branch }) });
    path = '';
    branch = undefined;
  };

  for (const raw of porcelain.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('worktree ')) {
      close();
      path = line.slice('worktree '.length);
    } else if (line.startsWith('branch refs/heads/')) {
      branch = line.slice('branch refs/heads/'.length);
    } else if (line === '') {
      close();
    }
  }
  close();
  return found;
}

/** True when git knows `path` as a worktree of `clone`. */
export function isRegisteredWorktree(clone: string, path: string): boolean {
  const want = pathKey(path);
  return worktrees(clone).some((w) => pathKey(w.path) === want);
}

/**
 * Which working tree has `branch` checked out, if any. The main clone counts,
 * so the answer can be a directory the pool does not own.
 */
export function worktreeHolding(clone: string, branch: string): string | undefined {
  return worktrees(clone).find((w) => w.branch === branch)?.path;
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
