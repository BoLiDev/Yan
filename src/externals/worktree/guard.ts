import { YanError } from '../../util/error.js';
import * as git from '../../util/git.js';
import { WORKTREE_FAILED } from './errors.js';

/**
 * The orphan-commit guard.
 *
 * Returning a tree destroys what is in it, so there is exactly one question:
 * would that lose anything? Two git commands answer it (worktree.md §7).
 *
 * There is deliberately no way to override this. boundaries.md §9.2 forbids a
 * force flag, and this is the last line of defence — a refusal means stop and
 * investigate, not try harder.
 *
 * Note what it does NOT test: whether the work has landed. That is a stronger
 * and different question, and it belongs to `yan shift done`, not here.
 */
export function assertReturnable(tree: string): void {
  if (git.statusPorcelain(tree).trim() !== '') {
    throw new YanError(
      WORKTREE_FAILED,
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
      WORKTREE_FAILED,
      `refusing to return ${tree}: no remote branch contains HEAD, so these commits exist nowhere else - push the branch first`,
    );
  }
}

/**
 * Reset and clean a tree back to a reusable state.
 *
 * `-fd` and NEVER `-x`. `-x` would delete the gitignored node_modules and build
 * caches too, which turns every lease back into a cold install and nothing
 * fails loudly when it happens. That is why the clean goes through
 * `util/git.ts`'s `cleanFd`, which hardcodes the flags, instead of being
 * spelled out here.
 */
export function wipe(tree: string): void {
  if (git.resetHard(tree).code !== 0) throw new YanError(WORKTREE_FAILED, `cannot reset ${tree}`);
  if (git.cleanFd(tree).code !== 0) throw new YanError(WORKTREE_FAILED, `cannot clean ${tree}`);
}
