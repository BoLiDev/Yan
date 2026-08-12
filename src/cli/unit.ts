import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { containerOf, display, unitTokens } from './shared/display.js';
import { repoDir } from './shared/repo.js';
import { callHook, HookError } from '../externals/conf-hook/index.js';
import { Terminal } from '../externals/herdr/index.js';
import { RemoteGit, type MrState } from '../externals/remote-git/index.js';
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

/**
 * Commander's repeatable-option accumulator.
 *
 * `previous` is whatever the option's default was on the first occurrence, and
 * `unit set --scope` deliberately defaults to `undefined` — "no --scope at all"
 * has to be distinguishable from "--scope with nothing in it", because the
 * first changes nothing and the second REPLACES the whole list with empty.
 */
function collect(value: string, previous: readonly string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

// --- unit add ---------------------------------------------------------------

export interface AddOptions {
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

export interface AddResult {
  readonly task: string;
  readonly unit: string;
  readonly branch: string;
  readonly target: string;
  readonly name_from: NameSource;
  readonly branch_state: string;
}

/**
 * The command without the process around it.
 *
 * `yan task new` adds its units through this rather than re-implementing any of
 * it: the branch-name hook, the "stop if the hook refuses" rule, and making the
 * branch exist all live here, and two homes for those rules would be two homes
 * that drift.
 */
export function addTaskUnit(options: AddOptions): AddResult {
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

  return { task, unit, branch, target, name_from: from, branch_state: how };
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
  --branch  omit it and yan asks <vault>/hooks/branch-name; with no hook installed
            the built-in default is yan/<task>-<unit>-r<n>. A name that was
            given, or that the hook returned, is used exactly as it stands.

If the branch-name hook exits non-zero, this command stops and reports. It
never falls back to the built-in default.`,
  )
  .action(
    action('yan unit add', (options: AddOptions) => {
      const r = addTaskUnit(options);
      if (options.json === true) {
        out(JSON.stringify(r));
      } else {
        out(`${r.unit}  ${r.branch} → ${r.target}  (${r.branch_state}, name from ${r.name_from})`);
      }
    }),
  );

// --- unit set ---------------------------------------------------------------

/**
 * EVERY ONE OF THESE FOUR IS A DECISION, so `user` has to ask for it
 * (boundaries.md §9.2). That authority lives in AGENTS.md, where the model is
 * told not to run this on its own initiative. What this command guarantees is
 * the other half: it never invents a value. Nothing here has a default, and the
 * one thing that could be guessed — how the round being replaced ended — is
 * asked of the host, not of the caller.
 *
 * `end` is not a flag to be remembered. It is looked up (branching.md §6.4):
 *
 *     merged                   → delivered
 *     closed, or mr was empty  → abandoned
 *     still open               → NOT OVER. Ask `user` first.
 *     unreachable              → ask `user`.
 *
 * The last two stop the command with RC_ASK_USER. They are the two cases where
 * a wrong answer gets written into an append-only history and can never be
 * corrected, so the command refuses to decide and says what to ask. `--end` is
 * therefore not a way around the lookup; it is the only way `user`'s answer can
 * reach the history at all. Once the conclusion is written, the host is never
 * asked about that round again — the history has to explain itself.
 */

/** Nothing was changed; a person has to answer something first. */
const RC_ASK_USER = 4;

export interface SetOptions {
  task?: string;
  unit?: string;
  branch?: string | boolean;
  target?: string;
  mode?: string;
  base?: string;
  end?: string;
  reason?: string;
  at?: string;
  scope?: string[];
  json?: boolean;
}

/**
 * What `unit set` needs from the remote host: how the round being replaced
 * ended. `RemoteGit` is the real one.
 *
 * Separated for the same reason `yan wait` separates its two sources: a test
 * drives the decision rather than the process, and `open → merged` becomes
 * reproducible without a network or a stub binary on `PATH`.
 */
export type MrStateReader = (mr: string, dir: string) => MrState;

/** What `unit set` reports to Herdr. Display only, and never fatal. */
export interface Labeller {
  setWorkspaceTokens(workspace: string, tokens: Record<string, string>): void;
}

const set = new Command('set')
  .description("change a unit's branch, target, mode or scope")
  .option('--task <id>', 'the task the unit belongs to')
  .option('--unit <name>', 'the unit name')
  // The value is optional, and that is deliberate: `--branch <name>` is "use
  // this name", bare `--branch` is "start a new round and let the configured
  // authority name it". A git branch may not begin with a dash, so Commander's
  // own optional-value handling gets this right.
  .option('--branch [name]', 'start a NEW ROUND on that integration branch')
  .option('--target <branch>', 'where this unit delivers')
  .option('--mode <mode>', 'scout | branch | mr')
  .option('--base <ref>', 'what to cut the new branch from when it does not exist')
  .option('--end <end>', 'delivered | abandoned - how the round being replaced finished')
  .option('--reason <text>', 'REQUIRED when the round ends as abandoned')
  .option('--at <date>', 'the retirement date recorded in history[] (default: today)')
  .option('--scope <path>', 'repeatable; REPLACES the whole scope list', collect, undefined)
  .option('--json', 'print the unit as it now stands')
  .addHelpText(
    'after',
    `
usage: yan unit set --task <id> --unit <name> [changes]

  --base defaults to --target when the old round was delivered, and to the OLD
  BRANCH when it was abandoned, so the abandoned work is not lost
  (branching.md §6.3).

Every one of these is a decision: \`user\` has to ask for it (boundaries.md §9.2).
Exit 4 means nothing was changed and \`user\` has to answer something first.`,
  )
  .action(action('yan unit set', (options: SetOptions) => setUnit(options)));

/** The command without the process around it: everything that decides is here. */
export function setUnit(options: SetOptions, readMrState?: MrStateReader, terminal?: Labeller): void {
  const task = options.task ?? '';
  const unitName = options.unit ?? '';
  const wantBranch = options.branch !== undefined;
  const givenBranch = typeof options.branch === 'string' ? options.branch : undefined;
  const wantScope = options.scope !== undefined;

  if (task === '') throw CommandError.usage('unit_set', '--task is required');
  if (unitName === '') throw CommandError.usage('unit_set', '--unit is required');
  if (!wantBranch && !options.target && !options.mode && !wantScope) {
    throw CommandError.usage('unit_set', 'nothing to change - pass --branch, --target, --mode or --scope');
  }
  const end0 = options.end ?? '';
  if (end0 !== '' && end0 !== 'delivered' && end0 !== 'abandoned') {
    throw CommandError.usage('unit_set', `--end is 'delivered' or 'abandoned', not '${end0}'`);
  }
  if (end0 !== '' && !wantBranch) {
    throw CommandError.usage('unit_set', '--end only applies to --branch: it says how the round being replaced finished');
  }

  if (!Task.exists(task)) throw CommandError.usage('unit_set', `no such task: ${task}`);
  const record = new Task(task);
  const unit = record.findUnit(unitName);
  if (unit === undefined) {
    throw CommandError.usage('unit_set', `no such unit: ${unitName} in ${task}`);
  }

  const changed: string[] = [];

  if (wantBranch) {
    const before = unit.read();
    const clone = repoDir('unit_set', before.repo, 'the unit names it, but nothing on this machine says where it is');
    // The round number of whatever is in unit.branch right now is
    // len(history) + 1. This rotation appends one entry, so the round being
    // STARTED is len(history) + 2. Getting this wrong is not cosmetic: the
    // built-in default would hand back the name of the branch being
    // replaced, which is exactly the collision the round number exists to
    // prevent — the same branch name cannot be created twice.
    const retiring = before.history.length + 1;
    const round = before.history.length + 2;

    if (before.branch === '') {
      throw new CommandError('unit_set', 'no_branch', "this unit has no current branch to replace - 'yan unit add' should have set one",
      );
    }

    let end = end0;
    let endFrom = '';
    if (end !== '') {
      endFrom = 'user';
    } else if (before.mr === null || before.mr === '') {
      // No outbound MR was ever opened for this round, so there is nothing
      // that could have been delivered (branching.md §6.4).
      end = 'abandoned';
      endFrom = 'no mr was ever opened';
    } else {
      // A host that errors and a host that answers `unknown` mean the same
      // thing here — we cannot tell how the round ended — so both land in
      // the same branch below.
      const ask = readMrState ?? ((mr: string, dir: string) => new RemoteGit().mrState({ mr, dir }));
      let state: MrState = 'unknown';
      try {
        state = ask(before.mr, clone);
      } catch {
        state = 'unknown';
      }
      if (state === 'merged') {
        end = 'delivered';
        endFrom = `the host says ${before.mr} is merged`;
      } else if (state === 'closed') {
        end = 'abandoned';
        endFrom = `the host says ${before.mr} is closed`;
      } else if (state === 'open') {
        throw new CommandError('unit_set', 'not_over', `this round is NOT OVER: ${before.mr} is still open on the forge. Ask 'user' first - should it be abandoned, or was replacing the branch a mistake? If it is to be abandoned, re-run with --end abandoned --reason '<why>'. Nothing was changed.`,
          { exitCode: RC_ASK_USER },
        );
      } else {
        throw new CommandError('unit_set', 'end_unknown', `cannot tell how this round ended: the forge could not be reached, or ${before.mr} no longer exists. Ask 'user' whether it was delivered or abandoned, then re-run with --end <delivered|abandoned> (and --reason for abandoned). Nothing was changed.`,
          { exitCode: RC_ASK_USER },
        );
      }
    }

    // An abandoned round has to say why (branching.md §6.4). The reason for
    // a normal rotation is obvious from context — it shipped, or feedback
    // came in — and the reason for dropping something is exactly the one
    // that gets forgotten.
    if (end === 'abandoned' && !options.reason) {
      throw CommandError.usage('unit_set', `--reason is required when a round is abandoned: log.md has to say why, because that is the one thing nobody remembers six months later. (${endFrom}.) Nothing was changed.`,
      );
    }

    const { branch, from: nameFrom } = decideBranchName(
      'unit_set',
      givenBranch,
      {
        task,
        task_title: record.title(),
        unit: unitName,
        repo: before.repo,
        target: options.target ?? before.target,
        scope: before.scope,
        round,
      },
      'the round was not rotated',
    );
    if (branch === before.branch) {
      throw CommandError.usage('unit_set', `the new integration branch is the same as the current one (${branch}) - a round is replaced by a DIFFERENT branch (branching.md §6.3)`,
      );
    }
    checkRefName('unit_set', branch);

    // The base is not a detail. branching.md §6.3: a delivered round is
    // followed by a branch off `target`, which already contains it; an
    // abandoned round is followed by a branch off THE OLD BRANCH ITSELF, so
    // the work that was dropped is still there to pick over.
    const base =
      options.base ?? (end === 'abandoned' ? before.branch : (options.target ?? before.target));
    const how = ensureBranch('yan unit set', clone, before.repo, branch, base);

    unit.rotate(end, branch, options.at ?? '');

    const line =
      end === 'abandoned'
        ? `${unitName}  abandoned ${before.branch} → ${branch} (based on ${base}; ${options.reason ?? ''})`
        : `${unitName}  delivered ${before.branch} → ${branch} (based on ${base}${options.reason ? `; ${options.reason}` : ''})`;
    try {
      new Log(task).append(line);
    } catch {
      process.stderr.write('yan unit set: task.json was updated but log.md was not appended to\n');
    }

    // display.md §4: a new round rewrites the workspace tokens. The workspace
    // is DERIVED from a live shift rather than created — a command that only
    // wants to relabel has no business making one — so a task with nothing
    // running simply has nothing on screen to relabel.
    const container = containerOf(task);
    if (container !== undefined) {
      display('could not rewrite the workspace tokens', () => {
        (terminal ?? new Terminal()).setWorkspaceTokens(container, unitTokens(task, unitName, branch));
      });
    }

    changed.push(`round ${retiring} ${end} on ${before.branch}; round ${round} is now ${branch} (${how}, name from ${nameFrom})`,
    );
  }

  // The three plain scalars run AFTER the rotation on purpose: the history
  // entry has to record the target the RETIRED round actually used, not the
  // one the next round will.

  if (options.target) {
    const old = unit.read().target;
    unit.set('target', options.target);
    try {
      new Log(task).append(`${unitName}  target ${old} → ${options.target}`);
    } catch { /* the change is recorded; the narration is not worth failing for */ }
    changed.push(`target=${options.target}`);
  }

  if (options.mode) {
    const old = unit.read().mode;
    unit.set('mode', options.mode);
    try {
      new Log(task).append(`${unitName}  mode ${old} → ${options.mode}`);
    } catch { /* as above */ }
    changed.push(`mode=${options.mode}`);
  }

  if (wantScope) {
    const scope = options.scope ?? [];
    unit.setScope(scope);
    try {
      new Log(task).append(`${unitName}  scope → ${scope.join(' ')}`);
    } catch { /* as above */ }
    changed.push(`scope=${scope.join(' ')}`);
  }

  if (options.json === true) out(JSON.stringify(unit.read(), null, 2));
  else out(`${task} ${unitName}  ${changed.join(' ')}`);
}

export const command = new Command('unit')
  .description("a task's units")
  .addCommand(add)
  .addCommand(set);
