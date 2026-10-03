import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { repoName } from './shared/repo-name.js';
import { requiredTask } from './shared/task-id.js';
import type { TaskRepo } from '../records/task/index.js';
import { YanError } from '../util/error.js';
import { branchOf, defaultBranch, remoteUrl, upstreamOf } from '../util/git.js';
import { repoKey } from '../util/repo-key.js';

/**
 * `yan branch` — the branch a task's work is on in one of its repositories,
 * kept in task.json so the next start, on any machine, puts the tree on it.
 * The agent keeps it, as it keeps a resource, rather than yan watching for
 * it: a branch is cut once, and the agent knows when it did.
 */

interface BranchOptions {
  repo?: string;
  task?: string;
}

/** The task's repository `given` names, by its name on screen or its URL. */
function namedRepo(repos: readonly TaskRepo[], given: string): TaskRepo {
  const found = repos.find((r) => repoName(r.url) === given || repoKey(r.url) === repoKey(given));
  if (found === undefined) {
    throw YanError.usage('branch_usage', `this task works in no repository called ${given} - it works in ${repos.map((r) => repoName(r.url)).join(', ')}`);
  }
  return found;
}

/**
 * The branch `dir` is on, as origin names it when it tracks one there.
 *
 * @throws YanError `branch_usage` on a detached HEAD.
 */
function branchIn(dir: string): string {
  const local = branchOf(dir);
  if (local === undefined) {
    throw YanError.usage('branch_usage', 'this worktree is on a detached HEAD - put it on the branch the work goes on first, or name one');
  }
  return upstreamOf(dir, local) ?? local;
}

export const command = new Command('branch')
  .description('keep the branch the work is on, once you have put a worktree on one, so later sessions start the worktree on it')
  .argument('[name]', 'the branch; by default the one this worktree is on')
  .option('--repo <name>', 'the repository, by name or URL; by default the one this worktree is of')
  .option('--task <id>', 'the task; defaults to $YAN_TASK')
  .action(
    action('yan branch', (name: string | undefined, options: BranchOptions) => {
      const task = requiredTask(options.task, '--task <id>');
      const repos = task.read().repos;
      if (repos.length === 0) throw YanError.usage('branch_usage', `${task.id} works in no repository, so it has no branch to keep`);

      const cwd = process.cwd();
      const hereUrl = remoteUrl(cwd);
      let repo: TaskRepo;
      if (options.repo !== undefined) {
        repo = namedRepo(repos, options.repo);
      } else if (hereUrl === undefined) {
        throw YanError.usage('branch_usage', 'this is not a worktree of a repository - run it in the task\'s worktree, or pass --repo <name>');
      } else {
        repo = namedRepo(repos, hereUrl);
      }
      const inTree = hereUrl !== undefined && repoKey(hereUrl) === repoKey(repo.url);
      if (name === undefined && !inTree) {
        throw YanError.usage('branch_usage', `this is not a worktree of ${repoName(repo.url)} - run it in one, or name the branch`);
      }

      const branch = name ?? branchIn(cwd);
      // A tree put on the default branch would hold it, and the clone beside it is usually on it.
      if (inTree && branch === defaultBranch(cwd)) {
        throw YanError.usage('branch_usage', `${branch} is origin's default branch, not one of this task's - put the worktree on a branch of its own first`);
      }
      const before = task.keepBranch(repo.url, branch);
      out(`${before !== undefined && before !== branch ? `replaced ${before} with` : 'kept'} ${branch.trim()} for ${repoName(repo.url)} → ${task.id}`);
    }),
  )
  .addHelpText(
    'after',
    `
Run it in the worktree once it is on the branch the work goes on, and again
if the work moves to another: the branch kept is the one the worktree is on,
as origin names it when it tracks one there. A name given is kept as it is.

The next time 'yan' opens a worktree of that repository for the task, on any
machine, it puts the tree on that branch: the clone's own, brought up to
origin's when it is only behind it, or a new one tracking origin's. A tree
yan cannot put on it starts on a detached HEAD, as one with no branch does.`,
  );
