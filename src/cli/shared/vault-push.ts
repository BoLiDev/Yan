import { join } from 'node:path';
import { keepTreeBranches } from './branches.js';
import { catchUp } from './vault-pull.js';
import { currentBranch, git, gitOk, remoteUrl, revParse, statusPorcelain } from '../../util/git.js';
import { YanError } from '../../util/error.js';
import { withLock } from '../../util/lock.js';

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
 * Keep the branch each open task's trees are on, commit everything, catch up
 * with origin, push. When there is nothing to commit and origin already has
 * every commit, it stops before the network: the hook runs after every turn,
 * and most turns change nothing here.
 *
 * @returns what it did, a line each.
 */
export function pushVault(dir: string, message: string | undefined): string[] {
  const said = keepTreeBranches().map((line) => `vault push: ${line}`);
  const changed = changedPaths(dir);

  const branch = currentBranch(dir);
  if (changed.length > 0) {
    gitOrThrow(dir, ['add', '-A'], 'staging the vault');
    gitOrThrow(dir, ['commit', '-m', message ?? pushMessage(changed)], 'committing the vault');
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
 * Commit what `user` just changed, and push it when the vault has an origin,
 * so the page shows it and the other machines get it. Under the lock.
 */
export function saveVault(dir: string, message: string): string[] {
  return withVaultLock(dir, () => {
    if (remoteUrl(dir) !== undefined) return pushVault(dir, message);
    if (changedPaths(dir).length === 0) return [];
    gitOrThrow(dir, ['add', '-A'], 'staging the vault');
    gitOrThrow(dir, ['commit', '-m', message], 'committing the vault');
    return ['vault push: committed, no origin to push to'];
  });
}
