import * as git from '../../util/git.js';
import { WorktreeError } from './errors.js';

/**
 * The orphan-commit guard: returning a tree destroys what is in it, so would
 * returning this one lose anything?
 *
 * A refusal has to be actionable, because the alternative is a stranded pool
 * slot. Whoever is holding the tree either finishes the work — commit, push —
 * or says explicitly that it can go; both routes are named in the message, and
 * the second one needs `user`'s word, which is why no caller can set `force` on
 * its own initiative.
 *
 * The refusal therefore lists what is actually in the way. "It has uncommitted
 * changes" sends the reader back to the tree to run `git status` themselves,
 * and the paths are the whole question.
 *
 * What this does not test is whether the work has LANDED. That is a stronger
 * and different question, and it belongs to `yan shift done`.
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
