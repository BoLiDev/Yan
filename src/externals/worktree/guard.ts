import * as git from '../../util/git.js';
import { WorktreeError } from './errors.js';

/**
 * Throws when returning this tree would lose work: it is dirty, or no remote
 * branch contains its HEAD. The refusal lists the paths in the way. Says
 * nothing about whether the work has landed — that is `yan shift done`.
 */
export function assertReturnable(tree: string): void {
  const dirty = git.statusPorcelain(tree).trim();
  if (dirty !== '') {
    const paths = dirty.split(/\r?\n/).map((l) => `  ${l.trim()}`);
    const shown = paths.length > 12 ? [...paths.slice(0, 12), `  … and ${paths.length - 12} more`] : paths;
    throw new WorktreeError(
      'failed',
      `refusing to return ${tree}: returning a tree destroys what is in it, and this one is dirty:\n${shown.join('\n')}\n` +
        'Commit and push what is worth keeping, or discard it deliberately with ' +
        "'yan tree return --discard --user-asked' once `user` has said so",
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
      `refusing to return ${tree}: no remote branch contains HEAD, so these commits exist nowhere else - push the branch, or discard them deliberately with 'yan tree return --discard --user-asked' once \`user\` has said so`,
    );
  }
}

/**
 * Reset and clean a tree back to a reusable state, keeping gitignored files so
 * the next lease stays warm.
 *
 * @throws WorktreeError when the reset or the clean fails.
 */
export function wipe(tree: string): void {
  if (git.resetHard(tree).code !== 0) throw new WorktreeError('failed', `cannot reset ${tree}`);
  if (git.cleanFd(tree).code !== 0) throw new WorktreeError('failed', `cannot clean ${tree}`);
}
