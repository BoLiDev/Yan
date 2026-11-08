import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { currentBranch, fetch, git, gitOk, rebase, remoteUrl, revParse, statusPorcelain } from '../../util/git.js';
import { YanError, isYanError } from '../../util/error.js';
import { vaultDir } from '../../util/vault.js';

/**
 * Catching the vault up with its origin: all of `yan vault pull`, and what
 * `yan vault push` does between committing and pushing, so a push from one
 * machine never fails for want of what another pushed first.
 */

export interface PullResult {
  readonly ok: boolean;
  readonly message: string;
  /** Origin has no branch of this name yet: nothing to catch up with, and a push publishes it. */
  readonly unpublished?: true;
}

/**
 * What git was left in the middle of in the vault, said as what to do about
 * it, or undefined: a rebase, a merge or a cherry-pick not finished, by a
 * pull stopped half-way or by `user` sorting out a conflict by hand. Nothing
 * yan does with the vault is safe then: a commit lands on the rebase's
 * detached HEAD, a half-resolved file and all, and the abort a failed catch-up
 * runs takes it away again, with whatever `user` had resolved.
 */
export function unfinished(dir: string): string | undefined {
  const gitDir = git(dir, ['rev-parse', '--git-dir']);
  if (gitDir.code !== 0) return undefined;
  const at = gitDir.stdout.trim();
  const inGit = (name: string): boolean => existsSync(join(isAbsolute(at) ? at : join(dir, at), name));
  const how = (what: string, done: string): string =>
    `the vault is in the middle of a ${what} - finish it ('git -C ${dir} ${done}') or give it up ('git -C ${dir} ${what} --abort'), then try again; nothing was changed`;
  if (inGit('rebase-merge') || inGit('rebase-apply')) return how('rebase', 'rebase --continue');
  if (inGit('MERGE_HEAD')) return how('merge', 'commit');
  if (inGit('CHERRY_PICK_HEAD')) return how('cherry-pick', 'cherry-pick --continue');
  return undefined;
}

/** `unfinished`, as the refusal of a command that would commit. */
export function refuseUnfinished(dir: string): void {
  const said = unfinished(dir);
  if (said !== undefined) throw new YanError('vault_unfinished', said);
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
  const stuck = unfinished(dir);
  if (stuck !== undefined) return { ok: false, message: stuck };
  const dirty = statusPorcelain(dir).trim();
  if (dirty !== '') {
    // Refused rather than attempted: a half-finished rebase in a directory the
    // reader does not think of as a repository is a bad place to be left.
    return {
      ok: false,
      message: `the vault has uncommitted changes, so it was not rebased - 'yan vault push' first, or commit them by hand:\n${dirty.split(/\r?\n/).slice(0, 10).map((l) => `    ${l}`).join('\n')}`,
    };
  }

  return catchUp(dir);
}

/**
 * Fetch origin and rebase the vault's branch onto it. The vault must be
 * clean, and in the middle of nothing (`unfinished`). A rebase that
 * conflicts is aborted, leaving the vault as it was.
 */
export function catchUp(dir: string): PullResult {
  const fetched = fetch(dir);
  if (fetched.code !== 0) {
    return { ok: false, message: `could not reach ${remoteUrl(dir) ?? 'origin'}: ${fetched.stderr.trim()}` };
  }
  const branch = currentBranch(dir);
  if (!gitOk(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])) {
    return { ok: false, unpublished: true, message: `origin has no ${branch} yet - 'yan vault push' publishes it` };
  }
  return rebaseOnto(dir, `origin/${branch}`);
}

/**
 * Rebase the vault's branch onto `upstream`, a commit of origin's this
 * machine has already fetched. A rebase that conflicts is aborted, leaving
 * the vault as it was.
 */
export function rebaseOnto(dir: string, upstream: string): PullResult {
  const before = revParse(dir, ['HEAD']);
  // Ctrl-C reaches git as well as yan: yan lives on through it, so the rebase
  // git was stopped in is undone below rather than left half-way, where the
  // next commit would land on its detached HEAD.
  const stay = (): void => {};
  process.on('SIGINT', stay);
  let rebased: ReturnType<typeof rebase>;
  try {
    rebased = rebase(dir, [upstream]);
  } finally {
    process.off('SIGINT', stay);
  }
  if (rebased.code !== 0) {
    // This rebase is this call's own, so undoing it is this call's to do; one
    // git refused to start, over a file written meanwhile say, left nothing to
    // undo, and is said as git said it rather than as a conflict.
    if (unfinished(dir) === undefined) {
      return { ok: false, message: `could not rebase onto ${upstream}: ${(rebased.stderr || rebased.stdout).trim()}` };
    }
    git(dir, ['rebase', '--abort']);
    return { ok: false, message: `rebasing onto ${upstream} conflicts - open ${dir} and sort it out; nothing was changed` };
  }
  const after = revParse(dir, ['HEAD']);
  return {
    ok: true,
    message: before === after ? `already up to date with ${upstream}` : `caught up with ${upstream}`,
  };
}
