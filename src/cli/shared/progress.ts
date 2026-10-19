import { repoName } from './repo-name.js';
import { tildePath } from './style.js';
import { leasesHeldBy, treeState } from '../../externals/worktree/index.js';
import { cloneFor } from '../../records/repos/index.js';
import type { Task } from '../../records/task/index.js';
import { branchOf, commitCount, defaultBranch, remoteUrl, revParse } from '../../util/git.js';
import { repoKey } from '../../util/repo-key.js';

/**
 * Where a task's work stands in each repository it works in, for `yan
 * context`: the branch, how far it is ahead of the default branch, what is
 * not pushed and what is not committed. The tree on this machine is read as
 * it is; a repository with no tree here is read from the clone as it was
 * last fetched, since context never waits on the network.
 */

export interface RepoProgress {
  readonly repo: string;
  readonly url: string;
  /** The branch the work is on: the tree's, or the one the task keeps when there is no tree here. */
  readonly branch: string | null;
  /** The commit a tree on a detached HEAD is at. */
  readonly detachedAt: string | null;
  readonly earlierBranches: readonly string[];
  /** This machine's tree of it. */
  readonly tree: string | null;
  /** The default branch it is compared with. */
  readonly base: string | null;
  /** Commits on the branch the default branch does not have; null when it cannot be told. */
  readonly ahead: number | null;
  /** Commits of the tree's no remote branch has; null without a tree. */
  readonly unpushed: number | null;
  /** Uncommitted changes and untracked files in the tree; null without a tree. */
  readonly uncommitted: number | null;
}

function short(dir: string): string | null {
  try {
    return revParse(dir, ['--short', 'HEAD']);
  } catch {
    return null;
  }
}

/** One entry per repository the task lists, in its order. */
export function taskProgress(task: Task): RepoProgress[] {
  const { repos } = task.read();
  const trees = leasesHeldBy(task.id).map((l) => ({ path: l.path, url: remoteUrl(l.path) }));
  return repos.map((r) => {
    const tree = trees.find((t) => t.url !== undefined && repoKey(t.url) === repoKey(r.url))?.path;
    const common = { repo: repoName(r.url), url: r.url, earlierBranches: r.earlierBranches ?? [] };
    if (tree !== undefined) {
      const base = defaultBranch(tree) ?? null;
      const branch = branchOf(tree) ?? null;
      const { dirty } = treeState(tree, { submoduleEdits: false });
      return {
        ...common,
        branch,
        detachedAt: branch === null ? short(tree) : null,
        tree,
        base,
        ahead: base === null ? null : commitCount(tree, [`origin/${base}..HEAD`]) ?? null,
        unpushed: commitCount(tree, ['HEAD', '--not', '--remotes']) ?? null,
        uncommitted: dirty.length,
      };
    }
    const clone = cloneFor(r.url);
    const base = clone === undefined ? null : defaultBranch(clone) ?? null;
    const ahead = clone === undefined || base === null || r.branch === undefined
      ? null
      : commitCount(clone, [`origin/${base}..origin/${r.branch}`]) ?? null;
    return { ...common, branch: r.branch ?? null, detachedAt: null, tree: null, base, ahead, unpushed: null, uncommitted: null };
  });
}

/**
 * Two lines per repository: the branch and where it stands, then the tree it
 * is in, or that there is none here.
 *
 *   yan  yan/t138-yan-r1  5 ahead of main · all pushed · 2 uncommitted
 *        ~/.yan/trees/Yan-553a9b26/1/Yan
 *        earlier: feat/old
 */
export function progressLines(progress: readonly RepoProgress[]): string[] {
  const width = Math.max(0, ...progress.map((p) => p.repo.length));
  return progress.flatMap((p) => {
    const where = p.branch ?? (p.detachedAt === null ? 'no branch yet' : `detached HEAD at ${p.detachedAt}`);
    const facts: string[] = [];
    if (p.ahead !== null && p.base !== null && p.branch !== null) facts.push(`${p.ahead} ahead of ${p.base}${p.tree === null ? ' on origin, as last fetched' : ''}`);
    if (p.unpushed !== null) facts.push(p.unpushed === 0 ? 'all pushed' : `${p.unpushed} not pushed`);
    if (p.uncommitted !== null) facts.push(p.uncommitted === 0 ? 'nothing uncommitted' : `${p.uncommitted} uncommitted`);
    const pad = ' '.repeat(width + 4);
    return [
      `  ${p.repo.padEnd(width)}  ${[where, facts.join(' · ')].filter((s) => s !== '').join('  ')}`,
      `${pad}${p.tree === null ? 'no worktree on this machine' : tildePath(p.tree)}`,
      ...(p.earlierBranches.length === 0 ? [] : [`${pad}earlier: ${p.earlierBranches.join(', ')}`]),
    ];
  });
}
