import { mergedInto } from './merged.js';
import { repoName } from './repo-name.js';
import { leasesHeldBy } from '../../externals/worktree/index.js';
import { Task, branchMark, isClosed, type BranchMark, type TaskRepo } from '../../records/task/index.js';
import { branchOf, defaultBranch, remoteUrl, upstreamOf } from '../../util/git.js';
import { repoKey } from '../../util/repo-key.js';

/**
 * A task keeps every branch its tree of a repository is on: the tree is
 * where the agent cuts them, so yan reads them there rather than waiting to
 * be told. In a monorepo a task may have a branch per app it changes, the one
 * tree moving between them, so the tree moving off a branch leaves it open;
 * only the agent can say one is given up, and only git that one is merged.
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
 * on, where it differs from the one kept last: open, as a new one or one the
 * work came back to. Run before the vault is committed, so a branch the
 * agent cut travels with the push that follows its turn. A tree yan cannot
 * read, or of a repository the task does not list, is left alone: this only
 * ever catches the record up.
 *
 * @returns a line for each branch it kept.
 */
export function keepTreeBranches(): string[] {
  const said: string[] = [];
  for (const id of Task.list()) {
    try {
      const task = new Task(id);
      const { state, repos } = task.read();
      if (isClosed(state)) continue;
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

/** Where one of a task's branches stands. */
export type BranchState = BranchMark | 'merged';

/**
 * Every branch the task kept in `repo`, the one its worktree was last on
 * first and the rest newest first, each with where it stands: merged when
 * git says so, read from `dir`, a tree or clone of it, as last fetched;
 * else what the task marks it. With no `dir`, the marks alone.
 */
export function branchStates(repo: TaskRepo, dir: string | undefined): { name: string; state: BranchState }[] {
  const names = [...(repo.branch === undefined ? [] : [repo.branch]), ...[...(repo.earlierBranches ?? [])].reverse()];
  const base = names.length === 0 || dir === undefined ? undefined : defaultBranch(dir);
  return names.map((name) => ({ name, state: base !== undefined && mergedInto(dir as string, name, base) ? 'merged' : branchMark(repo, name) }));
}
