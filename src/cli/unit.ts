import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { repoDir } from './shared/repo.js';
import { callHook, HookError } from '../externals/conf-hook/index.js';
import { Log } from '../records/log/index.js';
import { Task } from '../records/task/index.js';
import { branchExists, createBranch, fetch, gitOk } from '../util/git.js';

/**
 * `yan unit add` / `yan unit set` (branching.md §6.3–§6.5, boundaries.md §9.2,
 * §10).
 *
 * One unit is one sub-application is one branch is one tree, and both of these
 * commands settle things that are not yan's to settle alone:
 *
 *   target   NEVER DEFAULTED, by either command. During a release the team
 *            keeps a shared branch and everyone merges into it; in quiet
 *            periods everyone merges into master. A tool that guessed would be
 *            wrong about half the time, silently, and the mistake would only
 *            surface at the outbound MR.
 *
 *   branch   `user`'s decision, supplied in one of three ways: `--branch`, the
 *            `branch-name` hook, or the built-in `yan/<task>-<unit>-r<n>`.
 *            IF THE HOOK EXITS NON-ZERO, THE COMMAND STOPS. It never falls back
 *            to the built-in default — silently creating a branch that breaks
 *            the team's rules, and may not be mergeable at all, is far worse
 *            than failing outright.
 *
 * The branch then has to exist. `ensureBranch` below is the whole of that, and
 * it creates a REF, never a checkout: `repos/<repo>/` is read-only apart from
 * `git fetch` (boundaries.md §9.1). Working trees come from the pool.
 *
 * yan does not parse the resulting name (§6.6). It stores it in `unit.branch`
 * and that is where ownership is looked up afterwards.
 */

interface BranchNameContext {
  readonly task: string;
  readonly task_title: string;
  readonly unit: string;
  readonly repo: string;
  readonly target: string;
  readonly scope: readonly string[];
  readonly round: number;
}

type NameSource = 'user' | 'hook' | 'default';

/**
 * The hook is asked only when yan would otherwise have to invent a name. A name
 * `user` typed is already `user`'s decision, and the hook is one way of
 * supplying that decision, not a second owner of it (§6.5).
 */
function decideBranchName(
  command: string,
  given: string | undefined,
  context: BranchNameContext,
  refusalHint: string,
): { branch: string; from: NameSource } {
  if (given !== undefined && given !== '') return { branch: given, from: 'user' };

  let answered: string | undefined;
  try {
    answered = callHook('branch-name', context);
  } catch (err) {
    if (err instanceof HookError) {
      // THE ONE RULE THESE COMMANDS EXIST TO HOLD. The hook refused, so we
      // stop. Falling back here would create a branch the team's own tooling
      // has just rejected (boundaries.md §10).
      throw new CommandError(command, 'hook_refused', `the branch-name hook refused, so ${refusalHint} - ask 'user' how this unit's integration branch should be named, then pass it with --branch. yan will not fall back to its built-in default when an outside authority has said no`,
      );
    }
    throw err;
  }
  if (answered !== undefined) return { branch: answered, from: 'hook' };
  // No outside authority is configured. That is not an error; it is the
  // ordinary case, and the built-in default applies.
  return { branch: `yan/${context.task}-${context.unit}-r${context.round}`, from: 'default' };
}

function checkRefName(command: string, branch: string): void {
  if (/\s/.test(branch) || branch.startsWith('-')) {
    throw CommandError.usage(command, `the integration branch name '${branch}' is not usable as a git ref - fix the hook, or pass --branch`,
    );
  }
}

/**
 * `origin/<branch>` when it resolves, otherwise the empty string.
 *
 * origin/ is preferred over a local ref of the same name wherever both exist,
 * because a main clone is never checked out or pulled — the only write allowed
 * in it is a fetch — so its own `main` is whatever it was on the day it was
 * cloned, while `origin/main` is current.
 */
function remoteRef(clone: string, branch: string): string {
  return gitOk(clone, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
    ? `origin/${branch}`
    : '';
}

/** Make `branch` exist in the clone, as a ref. Returns how that happened. */
function ensureBranch(command: string, clone: string, repo: string, branch: string, base: string): string {
  // git fetch is the ONE write allowed inside a main clone. It may legitimately
  // fail offline, so it warns rather than stopping: the local refs are then
  // simply older than they could be.
  if (fetch(clone).code !== 0) {
    process.stderr.write(`${command}: could not fetch ${repo} - working from the refs already in the clone\n`);
  }

  if (branchExists(clone, branch)) return 'adopted the existing local branch';

  if (remoteRef(clone, branch) !== '') {
    // "The branch already exists on the remote → check it out" (boundaries.md
    // §10), done the only way a main clone allows: a ref, never a checkout.
    if (createBranch(clone, branch, `origin/${branch}`).code !== 0) {
      throw new CommandError(command, 'branch_failed', `cannot create a local ref for the existing remote branch '${branch}'`,
      );
    }
    return `adopted origin/${branch}`;
  }

  let baseRef = remoteRef(clone, base);
  if (baseRef === '') {
    if (branchExists(clone, base)) baseRef = base;
    else if (gitOk(clone, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) baseRef = base;
    else {
      throw new CommandError(command, 'base_unresolved', `cannot resolve the base '${base}' in ${clone} - fetch it, or pass --base with something that exists`,
      );
    }
  }
  if (createBranch(clone, branch, baseRef).code !== 0) {
    throw new CommandError(command, 'branch_failed', `cannot cut '${branch}' from '${baseRef}' in ${clone}`);
  }
  return `cut from ${baseRef}`;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

// --- unit add ---------------------------------------------------------------

interface AddOptions {
  task?: string;
  unit?: string;
  repo?: string;
  target?: string;
  branch?: string;
  base?: string;
  mode?: string;
  scope: string[];
  needs: string[];
  json?: boolean;
}

const add = new Command('add')
  .description('add a unit and make its integration branch exist')
  .option('--task <id>', 'the task the unit belongs to')
  .option('--unit <name>', 'the unit name')
  .option('--repo <repo>', 'a repository under repos/, or the path to a clone')
  .option('--target <branch>', 'REQUIRED: which branch this unit delivers into')
  .option('--branch <name>', "the integration branch's name")
  .option('--base <ref>', 'what to cut the branch from when it does not exist (default: --target)')
  .option('--mode <mode>', 'scout | branch | mr')
  .option('--scope <path>', 'repeatable; the paths this unit may touch', collect, [])
  .option('--needs <unit>', 'repeatable; unit names that must land before this one', collect, [])
  .option('--json', 'machine readable output')
  .addHelpText(
    'after',
    `
usage: yan unit add --task <id> --unit <name> --repo <repo> --target <branch>

  --target  REQUIRED, and never defaulted: which branch this unit's work is
            ultimately delivered into. There is no safe default (branching.md
            §6.4) - during a release the team merges into a shared branch, in
            quiet periods into master.
  --branch  omit it and yan asks conf/hooks/branch-name; with no hook installed
            the built-in default is yan/<task>-<unit>-r<n>. A name that was
            given, or that the hook returned, is used exactly as it stands.

If the branch-name hook exits non-zero, this command stops and reports. It
never falls back to the built-in default.`,
  )
  .action(
    action('yan unit add', (options: AddOptions) => {
      const task = options.task ?? '';
      const unit = options.unit ?? '';
      const repo = options.repo ?? '';
      const target = options.target ?? '';

      if (task === '') throw CommandError.usage('unit_add', '--task is required');
      if (unit === '') throw CommandError.usage('unit_add', '--unit is required');
      if (repo === '') {
        throw CommandError.usage('unit_add', '--repo is required: a repository under repos/, or the path to a clone');
      }
      // The one argument with no default anywhere in yan.
      if (target === '') {
        throw CommandError.usage('unit_add', "--target is required and is never guessed: say which branch this unit delivers into (branching.md §6.4 - a release period and a quiet period have different answers, so there is no safe default)",
        );
      }

      if (!Task.exists(task)) {
        throw CommandError.usage('unit_add', `no such task: ${task} - create it first`);
      }
      const record = new Task(task);
      if (record.findUnit(unit) !== undefined) {
        throw new CommandError('unit_add', 'exists', `unit already exists: ${unit} - 'yan unit set' changes one, 'yan ls ${task}' shows them`,
        );
      }

      const clone = repoDir('unit_add', repo);

      // n is the round number: len(history) + 1, so it needs no storage of its
      // own. A unit that is only now being added has no history, so this is r1
      // — but the expression is written the same way here and in `unit set`,
      // because that is the rule and not a coincidence.
      const round = 1;
      const { branch, from } = decideBranchName(
        'unit_add',
        options.branch,
        {
          task,
          task_title: record.title(),
          unit,
          repo,
          target,
          scope: options.scope,
          round,
        },
        'no unit was added',
      );
      checkRefName('unit_add', branch);

      const how = ensureBranch('yan unit add', clone, repo, branch, options.base ?? target);

      try {
        record.addUnit(unit, repo, target, {
          branch,
          mode: options.mode,
          scope: options.scope,
          needs: options.needs,
        });
      } catch (err) {
        throw new CommandError('unit_add', 'not_recorded', `the branch '${branch}' is ready in ${clone}, but task.json was not updated: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        new Log(task).append(`${unit}  unit added on ${branch} → ${target} (${how}; name from ${from})`);
      } catch {
        process.stderr.write('yan unit add: the unit was written but log.md was not appended to\n');
      }

      if (options.json === true) {
        out(JSON.stringify({ task, unit, branch, target, name_from: from, branch_state: how }));
      } else {
        out(`${unit}  ${branch} → ${target}  (${how}, name from ${from})`);
      }
    }),
  );

export const command = new Command('unit').description("a task's units").addCommand(add);
