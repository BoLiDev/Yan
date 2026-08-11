import * as git from '../../util/git.js';
import { WorktreeError } from './errors.js';

/**
 * The orphan-commit guard.
 *
 * Returning a tree destroys what is in it, so there is exactly one question:
 * would that lose anything? Two git commands answer it (worktree.md §7).
 *
 * NOTHING IN YAN MAY OVERRIDE THIS ON ITS OWN INITIATIVE, and for a long time
 * this comment said there was no override at all. That was a misreading of
 * boundaries.md §9.2, which does not forbid a force flag — it says
 *
 *     yan tree return --force   forbidden, unless `user` says the changes
 *                               can be thrown away
 *
 * which makes it an AUTHORITY, not an absence. The difference cost a real
 * stranded pool slot: a tree came back dirty, this refused exactly as it
 * should, and there was then no way at all to recover the slot.
 *
 * So the override exists and it is exactly one door wide: `yan done --force`,
 * whose flag carries `user`'s answer, reaching `WorktreePool.return({force})`.
 * `yan tree return` still has no flag. To this function a refusal still means
 * stop and investigate; who may decide otherwise is not its question.
 *
 * Note what it does NOT test: whether the work has landed. That is a stronger
 * and different question, and it belongs to `yan shift done`, not here.
 */
export function assertReturnable(tree: string): void {
  if (git.statusPorcelain(tree).trim() !== '') {
    throw new WorktreeError(
      'failed',
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
    throw new WorktreeError(
      'failed',
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
  if (git.resetHard(tree).code !== 0) throw new WorktreeError('failed', `cannot reset ${tree}`);
  if (git.cleanFd(tree).code !== 0) throw new WorktreeError('failed', `cannot clean ${tree}`);
}
