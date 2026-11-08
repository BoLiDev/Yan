import { join } from 'node:path';
import { noteBranchBases } from './branches.js';
import { catchUp, rebaseOnto, refuseUnfinished } from './vault-pull.js';
import { currentBranch, git, gitOk, remoteUrl, revParse, statusPorcelain } from '../../util/git.js';
import { YanError } from '../../util/error.js';
import { withLock } from '../../util/lock.js';
import { vaultDir } from '../../util/vault.js';

/**
 * Committing the vault and pushing it: `yan vault push`, the hook that runs
 * it after every turn, and `yan serve` after `user` changes something on its
 * page.
 */

export function gitOrThrow(dir: string, args: readonly string[], what: string): void {
  const result = git(dir, args);
  if (result.code !== 0) {
    const detail = (result.stderr === '' ? result.stdout : result.stderr).trim();
    throw new YanError('vault_git_failed', `${what} failed: git ${args.join(' ')}\n${detail}`);
  }
}

/**
 * The vault's lock, so the hooks of several agents on one machine, and
 * `yan serve`, take turns with git rather than colliding on its index.
 */
export function withVaultLock<T>(dir: string, body: () => T): T {
  return withLock(join(dir, '.git', 'yan-sync.lock'), 60, body);
}

/**
 * Everything in the vault staged and committed. yan's lock holds off yan, but
 * not the git `user` runs by hand: a `git pull --rebase` begun after a look
 * at the vault would have this commit land on its detached HEAD, a file with
 * its conflict markers and all. So the vault is looked at again just before
 * staging and just before committing, and a HEAD on no branch, as a rebase
 * leaves it, is refused, which leaves a gap of a few milliseconds and not
 * the length of a push.
 */
function commitAll(dir: string, message: string): void {
  refuseUnfinished(dir);
  gitOrThrow(dir, ['add', '-A'], 'staging the vault');
  refuseUnfinished(dir);
  if (!gitOk(dir, ['symbolic-ref', '-q', 'HEAD'])) {
    throw new YanError('vault_unfinished', `the vault is on no branch, as a rebase leaves it - put it back on its branch ('git -C ${dir} status' says how), then try again; nothing was committed`);
  }
  gitOrThrow(dir, ['commit', '-m', message], 'committing the vault');
}

/** A commit message naming the task ids that changed, for when nobody supplied one. */
function pushMessage(changed: readonly string[]): string {
  const tasks = [...new Set(changed.map((p) => /^tasks\/([^/]+)\//.exec(p)?.[1]).filter((id): id is string => id !== undefined))].sort();
  const others = changed.filter((p) => !p.startsWith('tasks/')).length;
  if (tasks.length === 0) return `vault: ${changed.length} file(s)`;
  const head = tasks.length > 4 ? `${tasks.slice(0, 4).join(', ')} and ${tasks.length - 4} more` : tasks.join(', ');
  return others > 0 ? `${head}, and ${others} other file(s)` : head;
}

/** What `git status` lists, a path each; --untracked-files=all, or a new directory counts as one entry. */
function changedPaths(dir: string): string[] {
  return statusPorcelain(dir, ['--untracked-files=all'])
    .split(/\r?\n/)
    .map((l) => l.slice(3).trim())
    .filter((p) => p !== '');
}

/**
 * Note where each open task's kept branches last met the default branch,
 * commit everything, catch up with origin, push. When there is nothing to commit and origin already has
 * every commit, it stops before the network: the hook runs after every turn,
 * and most turns change nothing here.
 *
 * @returns what it did, a line each.
 */
export function pushVault(dir: string, message: string | undefined): string[] {
  refuseUnfinished(dir);
  noteBranchBases();
  const said: string[] = [];
  const changed = changedPaths(dir);

  const branch = currentBranch(dir);
  if (changed.length > 0) {
    commitAll(dir, message ?? pushMessage(changed));
    said.push(`vault push: committed ${changed.length} change(s)`);
  } else if (gitOk(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]) && revParse(dir, ['HEAD']) === revParse(dir, [`origin/${branch}`])) {
    return ['vault push: nothing to push'];
  } else {
    said.push('vault push: nothing to commit');
  }

  // Another machine may have pushed since this one last pulled.
  const caught = catchUp(dir);
  if (!caught.ok && caught.unpublished !== true) {
    throw new YanError('vault_push_behind', `${caught.message}\nThe commit stays here, unpushed`);
  }
  if (caught.ok && !caught.message.startsWith('already')) said.push(`vault push: ${caught.message}`);

  gitOrThrow(dir, ['push', '-u', 'origin', branch], 'pushing the vault');
  said.push(`vault push: ${branch} → ${remoteUrl(dir) ?? 'origin'}`);
  return said;
}

/**
 * Bring the vault's branch up to `target`, origin as `yan serve` last
 * fetched it, which is what its page shows, so a change made on the page is
 * made to that rather than to an older copy here: an edit checked against
 * the file it began from, a deliverable named by its number, an artifact
 * another machine pushed. What is uncommitted here is committed first, as a
 * save would commit it, and what is here and not there is rebased onto it.
 * No network, under the lock. Throws, leaving the vault as it was, when it is
 * in the middle of something or what is here conflicts with `target`.
 */
export function levelWith(dir: string, target: string): void {
  // Most often there is nothing to do, and the lock, which an agent's hook may hold for a push, is not waited for.
  const level = (): boolean => gitOk(dir, ['merge-base', '--is-ancestor', target, 'HEAD']);
  // Asked before anything else: a vault in the middle of a rebase can look level, its detached HEAD past target.
  refuseUnfinished(dir);
  if (level()) return;
  withVaultLock(dir, () => {
    refuseUnfinished(dir);
    if (level()) return;
    const changed = changedPaths(dir);
    if (changed.length > 0) {
      commitAll(dir, pushMessage(changed));
    }
    const caught = rebaseOnto(dir, target);
    if (!caught.ok) throw new YanError('vault_behind', `this vault has commits of its own that conflict with what origin has - ${caught.message}`);
  });
}

/**
 * Commit what `user` just changed here, and nothing more: no fetch, no push,
 * so it is done before the network would have answered. Under the lock.
 */
export function commitVault(dir: string, message: string): string[] {
  return withVaultLock(dir, () => {
    if (changedPaths(dir).length === 0) return [];
    commitAll(dir, message);
    return ['vault push: committed here, to push later'];
  });
}

/**
 * Commit and push what a command just changed, so the other machines and
 * every `yan serve` have it now: `yan say`, and what `user` does at a
 * terminal (`pause`, `done`, `resume`, `repo add` and `rm`). The hook that
 * pushes at the end of an agent's turn runs only around an agent bare `yan`
 * started, so without this a task paused at a terminal stays uncommitted
 * here, the other machines still offer it, and the next pull is refused for
 * the dirty vault. The command has done its work either way, so a push that
 * fails is said on stderr, beginning with `what`, the commit kept here for
 * the next push, and does not fail the command.
 */
export function shareChange(what: string, message: string): 'pushed' | 'committed here' | 'not pushed' {
  try {
    return saveVault(vaultDir(), message).some((line) => line.includes(' → ')) ? 'pushed' : 'committed here';
  } catch (err) {
    process.stderr.write(`${what}, but the vault was not pushed: ${(err as Error).message}\n'yan vault push' tries again\n`);
    return 'not pushed';
  }
}

/**
 * Commit what `user` just changed, and push it when the vault has an origin,
 * so the page shows it and the other machines get it; with no message, one
 * made of the task ids that changed. Under the lock.
 */
export function saveVault(dir: string, message: string | undefined): string[] {
  return withVaultLock(dir, () => {
    if (remoteUrl(dir) !== undefined) return pushVault(dir, message);
    const changed = changedPaths(dir);
    if (changed.length === 0) return [];
    commitAll(dir, message ?? pushMessage(changed));
    return ['vault push: committed, no origin to push to'];
  });
}
