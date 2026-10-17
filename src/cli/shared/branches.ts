import { repoName } from './repo-name.js';
import { leasesHeldBy } from '../../externals/worktree/index.js';
import { Task } from '../../records/task/index.js';
import { branchOf, defaultBranch, remoteUrl, upstreamOf } from '../../util/git.js';
import { repoKey } from '../../util/repo-key.js';

/**
 * The branch a task keeps for a repository is the one its tree is on: the
 * tree is where the agent cuts it, so yan reads it there rather than waiting
 * to be told.
 */

/** A local branch as origin names it, when it tracks one there. */
export function asOriginNames(dir: string, local: string): string {
  return upstreamOf(dir, local) ?? local;
}

/**
 * The branch a tree's work is on, as origin names it: none on a detached
 * HEAD, or on origin's default branch, which is no task's own.
 */
function workBranch(tree: string): string | undefined {
  const local = branchOf(tree);
  if (local === undefined) return undefined;
  const branch = asOriginNames(tree, local);
  return branch === defaultBranch(tree) ? undefined : branch;
}

/**
 * Keep, for every open task, the branch each of its trees on this machine is
 * on, where it differs from the one kept. Run before the vault is committed,
 * so a branch the agent cut travels with the push that follows its turn. A
 * tree yan cannot read, or of a repository the task does not list, is left
 * alone: this only ever catches the record up.
 *
 * @returns a line for each branch it kept.
 */
export function keepTreeBranches(): string[] {
  const said: string[] = [];
  for (const id of Task.list()) {
    try {
      const task = new Task(id);
      const { state, repos } = task.read();
      if (state !== 'open') continue;
      for (const lease of leasesHeldBy(id)) {
        const url = remoteUrl(lease.path);
        const repo = url === undefined ? undefined : repos.find((r) => repoKey(r.url) === repoKey(url));
        const branch = repo === undefined ? undefined : workBranch(lease.path);
        if (repo === undefined || branch === undefined || branch === repo.branch) continue;
        task.keepBranch(repo.url, branch);
        said.push(`kept branch ${branch} for ${repoName(repo.url)} → ${id}`);
      }
    } catch {
      // A task.json yan cannot read, or a tree git cannot: the push goes on without it.
    }
  }
  return said;
}
