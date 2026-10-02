import * as git from '../../util/git.js';
import { YanError } from '../../util/error.js';

/** What a tree holds that exists nowhere else. */
export interface TreeState {
  /** `git status --porcelain` lines: uncommitted changes and untracked files. */
  readonly dirty: readonly string[];
  /** True when no remote branch contains HEAD, so its commits exist only here. */
  readonly unpushed: boolean;
}

/**
 * Read what a tree holds. Never throws: a tree git cannot read reports as clean.
 *
 * @param options.submoduleEdits false to skip what is uncommitted inside
 *   submodules: faster, for showing a tree, never for deciding to wipe one.
 */
export function treeState(tree: string, options: { submoduleEdits?: boolean } = {}): TreeState {
  let dirty: string[] = [];
  let unpushed = false;
  try {
    dirty = git.treeStatus(tree, options).split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
    unpushed = !git.headOnRemote(tree);
  } catch {
    // Reported as clean: the guard below asks again, and refuses on its own terms.
  }
  return { dirty, unpushed };
}

/**
 * Throws when returning this tree would lose work: it is dirty, or no remote
 * branch contains its HEAD. The refusal lists the paths in the way.
 */
export function assertReturnable(tree: string): void {
  const { dirty, unpushed } = treeState(tree);
  if (dirty.length > 0) {
    const paths = dirty.map((l) => `  ${l}`);
    const shown = paths.length > 12 ? [...paths.slice(0, 12), `  … and ${paths.length - 12} more`] : paths;
    throw new YanError('worktree_failed',
      `refusing to return ${tree}: returning a tree wipes it, and this one has changes:\n${shown.join('\n')}\n` +
        'Commit and push what is worth keeping, or pass --force to throw it away',
    );
  }
  if (unpushed) {
    throw new YanError('worktree_failed',
      `refusing to return ${tree}: no remote branch contains HEAD, so these commits exist nowhere else - push the branch, or pass --force to leave them behind (the branch itself stays)`,
    );
  }
}

/**
 * Reset and clean a tree back to a reusable state, keeping gitignored files so
 * the next lease stays warm.
 *
 * @throws YanError when the reset or the clean fails.
 */
export function wipe(tree: string): void {
  if (git.resetHard(tree).code !== 0) throw new YanError('worktree_failed', `cannot reset ${tree}`);
  if (git.cleanFd(tree).code !== 0) throw new YanError('worktree_failed', `cannot clean ${tree}`);
}
