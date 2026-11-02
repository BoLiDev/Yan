import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { asOriginNames, branchStates } from './shared/branches.js';
import { repoName } from './shared/repo-name.js';
import { requiredTask } from './shared/task-id.js';
import { cloneFor } from '../records/repos/index.js';
import type { TaskRepo } from '../records/task/index.js';
import { YanError } from '../util/error.js';
import { branchOf, defaultBranch, remoteUrl } from '../util/git.js';
import { repoKey } from '../util/repo-key.js';

/**
 * `yan branch` — a task's branches in one of its repositories, kept in
 * task.json so the next start, on any machine, puts the tree on the last
 * one kept. Only the agent keeps them, here: a tree passes through branches
 * that are nobody's work, so yan takes none for the task's because a tree is
 * on it (`shared/branches.ts`). One is in progress for each app or package
 * the task changes; keeping one says which others are in progress there, so
 * the agent sees them as it keeps it. `abandon` marks one given up, which
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
  .description('keep a branch as the task\'s, in progress, as soon as it is cut - one is in progress for each app or package the task changes')
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
      const kept = branch.trim();
      out(`kept ${kept} for ${repoName(repo.url)}, in progress → ${task.id}`);
      // Read from the tree, or else the clone, so one merged since is not said to be in progress.
      const now = task.read().repos.find((r) => repoKey(r.url) === repoKey(repo.url));
      const others = now === undefined ? [] : branchStates(now, inTree ? cwd : cloneFor(repo.url)).filter((b) => b.state === 'open' && b.name !== kept).map((b) => b.name);
      if (others.length > 0) {
        out(`also in progress in ${repoName(repo.url)}: ${others.join(', ')} - one branch is in progress for each app or package: if ${kept} takes over the work of one, 'yan branch abandon <name>' marks it given up`);
      }
    }),
  );

const abandon = new Command('abandon')
  .description('mark a branch of the task given up, as soon as its work moves to another branch or stops - only marked, never deleted')
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
  .description('the task\'s branches, which only you keep: bare, keep the one this worktree is on as it is cut; \'yan branch abandon <name>\' marks one given up - one is in progress for each app or package')
  .addCommand(keep, { isDefault: true })
  .addCommand(abandon)
  .addHelpText(
    'after',
    `
A task's branches are the ones it keeps, and only you keep them: yan does
not take a branch for the task's because a worktree is on it. Keep one with
bare 'yan branch' in the worktree as soon as you cut it, as origin names it
when it tracks one there; a name given is kept as it is, for a repository
with no worktree here.

One branch is in progress for each app the task changes: in a repository of
one app, one branch; in a monorepo, one for each app or package the task
changes, the worktree switching between them. The work on an app goes on
its branch, a fix or a second try included; a branch only tried something
out stays out of the worktree, and is not kept. Each is in progress until a
merge commit takes it into origin's default branch, which yan reads from
git, or until it is marked given up:

  yan branch abandon feat/login-v1

Mark one so as soon as its work moves to another branch, or stops. It is
only marked: nothing is deleted, here or on origin. Keeping it again brings
it back in progress.

The next time 'yan' opens a worktree of that repository for the task, on any
machine, it puts the tree on the branch kept last: the clone's own,
brought up to origin's when it is only behind it, or a new one tracking
origin's. A tree yan cannot put on it starts on a detached HEAD, as one with
no branch does.`,
  );
