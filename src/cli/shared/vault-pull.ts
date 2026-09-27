import { currentBranch, fetch, git, gitOk, rebase, remoteUrl, revParse, statusPorcelain } from '../../util/git.js';
import { isYanError } from '../../util/error.js';
import { vaultDir } from '../../util/vault.js';

/**
 * Catching the vault up with its origin: `yan vault pull`, and the first
 * thing `yan session-start` does. Here rather than in `vault.ts` because a
 * command does not import another command.
 */

export interface PullResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Fast-forward the vault from its origin. Never throws: no vault, no origin,
 * a dirty tree or an unreachable remote all come back as `ok: false`.
 */
export function pullVault(): PullResult {
  let dir: string;
  try {
    dir = vaultDir();
  } catch (err) {
    return { ok: false, message: isYanError(err) ? err.message : String(err) };
  }

  if (remoteUrl(dir) === undefined) {
    return { ok: false, message: 'this vault has no origin, so there is nothing to pull from' };
  }
  const dirty = statusPorcelain(dir).trim();
  if (dirty !== '') {
    // Refused rather than attempted: a half-finished rebase in a directory the
    // reader does not think of as a repository is a bad place to be left.
    return {
      ok: false,
      message: `the vault has uncommitted changes, so it was not rebased - 'yan vault push' first, or commit them by hand:\n${dirty.split(/\r?\n/).slice(0, 10).map((l) => `    ${l}`).join('\n')}`,
    };
  }

  const fetched = fetch(dir);
  if (fetched.code !== 0) {
    return { ok: false, message: `could not reach ${remoteUrl(dir) ?? 'origin'}: ${fetched.stderr.trim()}` };
  }
  const branch = currentBranch(dir);
  if (!gitOk(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) {
    return { ok: false, message: `origin has no ${branch} yet - 'yan vault push' publishes it` };
  }

  const before = revParse(dir, ['HEAD']);
  const rebased = rebase(dir, [`origin/${branch}`]);
  if (rebased.code !== 0) {
    git(dir, ['rebase', '--abort']);
    return { ok: false, message: `rebasing onto origin/${branch} conflicts - open ${dir} and sort it out; nothing was changed` };
  }
  const after = revParse(dir, ['HEAD']);
  return {
    ok: true,
    message: before === after ? `already up to date with origin/${branch}` : `caught up with origin/${branch}`,
  };
}
