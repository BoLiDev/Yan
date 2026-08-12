import * as git from '../../util/git.js';
import { WorktreeError } from './errors.js';

/**
 * The orphan-commit guard: returning a tree destroys what is in it, so would
 * returning this one lose anything?
 *
 * A refusal here means stop and investigate. There is exactly one way past it —
 * `yan done --force`, which reaches `WorktreePool.return({force})` carrying
 * `user`'s answer that the work can be thrown away. `yan tree return` exposes
 * no such flag, deliberately. Who may decide to override is not this function's
 * question, but note that some caller must be able to: without a door at all, a
 * tree that comes back dirty strands its pool slot permanently.
 *
 * What it does not test is whether the work has landed. That is a stronger and
 * different question, and it belongs to `yan shift done`.
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
 * `-fd` and never `-x`: `-x` would take the gitignored node_modules and build
 * caches with it, turning every lease back into a cold install, and nothing
 * fails loudly when that happens. The flags are not spelled out here for that
 * reason — the clean goes through `util/git.ts`'s `cleanFd`, which hardcodes
 * them where a well-meaning edit will not find them.
 */
export function wipe(tree: string): void {
  if (git.resetHard(tree).code !== 0) throw new WorktreeError('failed', `cannot reset ${tree}`);
  if (git.cleanFd(tree).code !== 0) throw new WorktreeError('failed', `cannot clean ${tree}`);
}
