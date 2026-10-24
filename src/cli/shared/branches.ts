import { mergedInto } from './merged.js';
import { repoName } from './repo-name.js';
import { leasesHeldBy } from '../../externals/worktree/index.js';
import { Task, branchMark, isClosed, type BranchMark, type TaskRepo } from '../../records/task/index.js';
import { branchOf, defaultBranch, git, remoteUrl, upstreamOf } from '../../util/git.js';
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
 * HEAD, or on origin's default branch, `target`, which is no task's own.
 */
function workBranch(tree: string, target: string | undefined): string | undefined {
  const local = branchOf(tree);
  if (local === undefined) return undefined;
  const branch = asOriginNames(tree, local);
  return branch === target ? undefined : branch;
}

/**
 * Where the branch `tree` is on last met `target`, as last fetched, while
 * it has commits `target` lacks: their merge-base, which moves on each time
 * `target` is merged in. Undefined once it has none, so a branch
 * fast-forwarded in keeps the point it left from. A branch just cut, with
 * nothing of its own yet, gets none either: noting its head would make it
 * read as merged once it caught up with `target`, with `target`'s commits
 * shown as its own.
 */
function metTargetAt(tree: string, target: string): string | undefined {
  const at = (ref: string): string | undefined => {
    const r = git(tree, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return r.code === 0 && r.stdout.trim() !== '' ? r.stdout.trim() : undefined;
  };
  const tip = at(`refs/remotes/origin/${target}`) ?? at(`refs/heads/${target}`);
  const head = at('HEAD');
  if (tip === undefined || head === undefined || git(tree, ['merge-base', '--is-ancestor', head, tip]).code === 0) return undefined;
  const base = git(tree, ['merge-base', tip, head]);
  return base.code === 0 && base.stdout.trim() !== '' ? base.stdout.trim() : undefined;
}

/**
 * Keep, for every open task, the branch each of its trees on this machine is
 * on, where it differs from the one kept last: open, as a new one or one the
 * work came back to; and note where that branch last met the default
 * branch, for telling it merged once it is fast-forwarded in. Run before the
 * vault is committed, so a branch the agent cut travels with the push that
 * follows its turn. A tree yan cannot read, or of a repository the task does
 * not list, is left alone: this only ever catches the record up.
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
        if (repo === undefined) continue;
        const target = defaultBranch(lease.path);
        const branch = workBranch(lease.path, target);
        if (branch === undefined) continue;
        if (branch !== repo.branch) {
          task.keepBranch(repo.url, branch);
          said.push(`kept branch ${branch} for ${repoName(repo.url)} → ${id}`);
        }
        const met = target === undefined ? undefined : metTargetAt(lease.path, target);
        if (met !== undefined && met !== repo.branchBases?.[branch]) task.noteBranchBase(repo.url, branch, met);
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
  return names.map((name) => ({ name, state: base !== undefined && mergedInto(dir as string, name, base, repo.branchBases?.[name]) ? 'merged' : branchMark(repo, name) }));
}
