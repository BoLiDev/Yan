import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { asOriginNames } from './shared/branches.js';
import { repoName } from './shared/repo-name.js';
import { requiredTask } from './shared/task-id.js';
import type { TaskRepo } from '../records/task/index.js';
import { YanError } from '../util/error.js';
import { branchOf, defaultBranch, remoteUrl } from '../util/git.js';
import { repoKey } from '../util/repo-key.js';

/**
 * `yan branch` — a task's branches in one of its repositories, kept in
 * task.json so the next start, on any machine, puts the tree on the last
 * one. `yan vault push`, and so the hook after every turn, keeps the branch
 * each tree is on by itself (`shared/branches.ts`); bare, this keeps one by
 * hand: a branch named for a repository with no tree here, or one kept
 * before the push that would keep it. `abandon` marks one given up, which
 * nothing else can tell.
 */

interface BranchOptions {
  repo?: string;
  task?: string;
}

/**
 * The repository a command run in `cwd` means: the one `given` names, by
 * its name on screen or its URL, else the one `cwd` is a worktree of.
 */
function repoMeant(repos: readonly TaskRepo[], given: string | undefined, hereUrl: string | undefined): TaskRepo {
  if (given !== undefined) return namedRepo(repos, given);
  if (hereUrl === undefined) {
    throw YanError.usage('branch_usage', 'this is not a worktree of a repository - run it in the task\'s worktree, or pass --repo <name>');
  }
  return namedRepo(repos, hereUrl);
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
  return asOriginNames(dir, local);
}

const keep = new Command('keep')
  .description('keep a branch for the task by hand, in progress - the one each worktree is on is kept by itself whenever the vault is pushed')
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
      const repo = repoMeant(repos, options.repo, hereUrl);
      const inTree = hereUrl !== undefined && repoKey(hereUrl) === repoKey(repo.url);
      if (name === undefined && !inTree) {
        throw YanError.usage('branch_usage', `this is not a worktree of ${repoName(repo.url)} - run it in one, or name the branch`);
      }

      const branch = name ?? branchIn(cwd);
      // A tree put on the default branch would hold it, and the clone beside it is usually on it.
      if (inTree && branch === defaultBranch(cwd)) {
        throw YanError.usage('branch_usage', `${branch} is origin's default branch, not one of this task's - put the worktree on a branch of its own first`);
      }
      task.keepBranch(repo.url, branch);
      out(`kept ${branch.trim()} for ${repoName(repo.url)}, in progress → ${task.id}`);
    }),
  );

const abandon = new Command('abandon')
  .description('mark a branch of the task given up, once the work has left it for another - only marked, never deleted')
  .argument('<name>', 'the branch, as the task keeps it')
  .option('--repo <name>', 'the repository, by name or URL; by default the one this worktree is of, or the task\'s only one')
  .option('--task <id>', 'the task; defaults to $YAN_TASK')
  .action(
    action('yan branch abandon', (name: string, options: BranchOptions) => {
      const task = requiredTask(options.task, '--task <id>');
      const repos = task.read().repos;
      if (repos.length === 0) throw YanError.usage('branch_usage', `${task.id} works in no repository, so it has no branch to give up`);
      const repo = options.repo === undefined && repos.length === 1 ? repos[0] as TaskRepo : repoMeant(repos, options.repo, remoteUrl(process.cwd()));
      const changed = task.abandonBranch(repo.url, name);
      out(`${name.trim()} in ${repoName(repo.url)} ${changed ? 'marked abandoned' : 'was abandoned already'} → ${task.id}`);
    }),
  );

export const command = new Command('branch')
  .description('the task\'s branches: bare, keep one by hand; \'yan branch abandon <name>\' marks one given up - the one each worktree is on is kept by itself whenever the vault is pushed')
  .addCommand(keep, { isDefault: true })
  .addCommand(abandon)
  .addHelpText(
    'after',
    `
Every 'yan vault push' keeps the branch each of the task's worktrees on
this machine is on, as origin names it when it tracks one there; a detached
HEAD or origin's default branch keeps nothing. Bare 'yan branch' keeps one
sooner, or for a repository with no worktree here; a name given is kept as
it is.

A task may have several branches in one repository, in a monorepo one for
each app it changes, the worktree switching between them. Each is in
progress until a merge commit takes it into origin's default branch, which
yan reads from git, or until it is marked given up:

  yan branch abandon feat/login-v1

Mark one so once the work has left it for good, for another branch. It is
only marked: nothing is deleted, here or on origin. A worktree put back on
it later brings it back in progress.

The next time 'yan' opens a worktree of that repository for the task, on any
machine, it puts the tree on the branch it was last on: the clone's own,
brought up to origin's when it is only behind it, or a new one tracking
origin's. A tree yan cannot put on it starts on a detached HEAD, as one with
no branch does.`,
  );
