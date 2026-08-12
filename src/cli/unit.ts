import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { containerOf, display, unitTokens } from './shared/display.js';
import { repoDir } from './shared/repo.js';
import { Terminal } from '../externals/herdr/index.js';
import { RemoteGit, type MrState } from '../externals/remote-git/index.js';
import { Log } from '../records/log/index.js';
import { Task } from '../records/task/index.js';
import { branchExists, commitTree, createBranch, fetch, gitLines, gitOk, mergeTree, push, revParse, updateRef } from '../util/git.js';

/**
 * `yan unit add` / `yan unit set`.
 *
 * One unit is one sub-application is one branch is one tree, and both of these
 * commands settle things that are not yan's to settle alone:
 *
 *   target   never defaulted, by either command. During a release the team
 *            keeps a shared branch and everyone merges into it; in quiet
 *            periods everyone merges into master. A tool that guessed would be
 *            wrong about half the time, silently, and the mistake would only
 *            surface at the outbound MR.
 *
 *   branch   supplied in one of three ways, and who creates the branch
 *            follows from which one:
 *
 *              default        yan names it `yan/<task>-<unit>-r<n>`, yan cuts it
 *              --branch       you name it, yan cuts it (or adopts it if it exists)
 *              branch-create  your hook cuts it and prints the name; yan verifies
 *
 *            If the hook exits non-zero, the command stops. It never falls back
 *            to the built-in default — silently creating a branch that breaks
 *            the team's rules, and may not be mergeable at all, is far worse
 *            than failing outright. Its stderr comes back with the refusal.
 *
 * The hook is called `branch-create` and not `branch-name` because that is what
 * it does: a company tool typically opens the branch in a ticket system or on
 * the forge and then reports what it called it. So yan does not cut a branch it
 * was given by a hook — it checks that one exists, and refuses if it does not.
 * Taking the hook's word for it would record a branch that is not there, and
 * the failure would surface two commands later inside the worktree pool.
 *
 * What the hook is not responsible for is inheriting the previous round. A
 * created branch is normally cut straight from the repository's main branch,
 * which is exactly what a company tool does; carrying an abandoned round's
 * commits forward is yan's own step, run afterwards, because it is a judgement
 * about not losing work rather than a naming rule.
 *
 * `ensureBranch` is the whole of "make it exist" for the two paths where yan
 * creates, and it creates a ref, never a checkout: cutting a branch in the main
 * clone is `git branch`, which leaves whoever is working there on the branch
 * they were on. Working trees come from the pool.
 *
 * yan does not parse the resulting name. It stores it in `unit.branch`, and that
 * is where ownership is looked up afterwards.
 */

/** What the built-in name is made of. */
interface BranchNameContext {
  readonly task: string;
  readonly unit: string;
  readonly round: number;
}

type NameSource = 'user' | 'default';

/**
 * The hook is asked only when yan would otherwise have to invent a name. A name
 * `user` typed is already `user`'s decision, and the hook is one way of
 * supplying that decision, not a second owner of it (§6.5).
 */
function decideBranchName(
  given: string | undefined,
  context: BranchNameContext,
): { branch: string; from: NameSource; raw?: string } {
  if (given !== undefined && given !== '') {
    // Whatever spelling it arrived in. `--branch` is routinely a paste of
    // something a company tool printed, and `refs/heads/x` is a name.
    return { branch: normalizeBranchName(given), from: 'user', raw: given };
  }
  // Nobody said, so the built-in applies. That is the ordinary case and not a
  // fallback from anything.
  return { branch: `yan/${context.task}-${context.unit}-r${context.round}`, from: 'default' };
}


/**
 * What a tool printed, as a branch name.
 *
 * A narrow, named exception to "yan never parses the name it gets back". That
 * rule is about ownership — who a branch belongs to is looked up in
 * `task.json`, never inferred from a prefix — and nothing here infers anything. What it does is accept the spellings real tooling emits for
 * the same ref: `refs/heads/x`, `origin/x`, a quoted name, a trailing CR.
 *
 * The alternative was tried by leaving it alone, and it is worse: the odd
 * spelling goes into `task.json` verbatim and fails later, somewhere that has
 * no idea a hook was involved.
 */
export function normalizeBranchName(raw: string): string {
  let name = raw.trim().replace(/\r/g, '');
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
    name = name.slice(1, -1).trim();
  }
  name = name.replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  return name.trim();
}

function checkRefName(command: string, branch: string, raw?: string): void {
  const bad = branch === '' || /\s/.test(branch) || branch.startsWith('-') || branch.endsWith('/');
  if (bad) {
    // The raw text, because "that is not a usable ref" about a normalised
    // string sends the reader looking for a name their tool never printed.
    const from = raw !== undefined && raw !== branch ? ` (from '${raw}')` : '';
    throw CommandError.usage(command, `'${branch}'${from} is not usable as a git ref - fix the hook, or pass --branch`,
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
  // git fetch is the one write allowed inside a main clone. It may legitimately
  // fail offline, so it warns rather than stopping: the local refs are then
  // simply older than they could be.
  if (fetch(clone).code !== 0) {
    process.stderr.write(`${command}: could not fetch ${repo} - working from the refs already in the clone\n`);
  }

  if (branchExists(clone, branch)) return 'adopted the existing local branch';

  if (remoteRef(clone, branch) !== '') {
    // "The branch already exists on the remote → check it out" (see
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



export interface Inherited {
  /** What happened, in one line, for the caller to print and to log. */
  readonly said: string;
  /** True when commits were carried forward and the branch moved. */
  readonly moved: boolean;
  /** Paths git could not merge. Non-empty means nobody carried anything. */
  readonly conflicts: readonly string[];
}

/**
 * Carry the round being replaced forward onto the new integration branch.
 *
 * Why this is yan's job and not the hook's. A `branch-create` hook cuts where
 * the team cuts, normally straight off the main branch, and it should not have
 * to know that yan is in the middle of replacing a round. Not losing commits is
 * a judgement about work, so it stays here, and it runs after the new branch is
 * known to exist.
 *
 * Why it happens in the main clone. Because it can: `merge-tree --write-tree`
 * does a real three-way merge into the object store and hands back a tree, so
 * the whole operation is ref and object writes with no checkout — which is what
 * the main-clone rule actually forbids (util/git.ts says this at length). No
 * lease, no worktree, no tree to return if something throws halfway.
 *
 * Three outcomes, and the middle one is the point:
 *
 *   nothing to carry   the old branch has no commit the new one lacks. The
 *                      ordinary case after a delivered round, since target
 *                      already contains it
 *   carried            a merge commit lands on the new branch and is pushed
 *   conflicts          not an error here. The rotation itself already
 *                      happened and is correct; this says so loudly and names
 *                      the paths, and the same conflict is waiting for a shift
 *                      in a real worktree. Refusing to rotate over it would put
 *                      the strictness back exactly where it was taken out
 */
export function inheritRound(clone: string, from: string, to: string): Inherited {
  if (!branchExists(clone, from) || !branchExists(clone, to)) {
    return { said: 'nothing was carried forward: one of the two branches is not in this clone', moved: false, conflicts: [] };
  }

  const ahead = gitLines(clone, ['rev-list', '--count', `${to}..${from}`]).join('').trim();
  if (ahead === '' || ahead === '0') {
    return { said: `nothing to carry forward: ${to} already has everything on ${from}`, moved: false, conflicts: [] };
  }

  const merged = mergeTree(clone, to, from);
  if (merged.code !== 0) {
    // git prints the tree, then an "Auto-merging"/conflict section. The paths
    // are what a person needs; the rest is git talking to itself.
    const conflicts = [
      ...new Set(
        merged.stdout
          .split(/\r?\n/)
          .map((l) => /^(?:CONFLICT|Auto-merging)[^)]*\)?\s*(.*)$/.exec(l.trim())?.[1] ?? '')
          .filter((p) => p !== ''),
      ),
    ];
    return {
      said: `${ahead} commit(s) on ${from} did NOT carry forward: they conflict with ${to}`,
      moved: false,
      conflicts,
    };
  }

  const tree = merged.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  const ours = revParse(clone, [to]);
  const theirs = revParse(clone, [from]);
  const commit = commitTree(clone, tree, [ours, theirs], `carry ${from} forward onto ${to}`);
  if (commit.code !== 0 || commit.stdout.trim() === '') {
    return { said: `could not commit the carried work: ${commit.stderr.trim()}`, moved: false, conflicts: [] };
  }
  const moved = updateRef(clone, `refs/heads/${to}`, commit.stdout.trim(), ours);
  if (moved.code !== 0) {
    return { said: `could not move ${to} onto the carried work: ${moved.stderr.trim()}`, moved: false, conflicts: [] };
  }

  // Pushing is a network write, not a working-tree one, so the main clone is
  // the right place for it. A push that fails is reported and nothing else:
  // the commits are safe on the local branch either way.
  const pushed = push(clone, ['origin', to]);
  return {
    said:
      pushed.code === 0
        ? `carried ${ahead} commit(s) from ${from} onto ${to}, and pushed`
        : `carried ${ahead} commit(s) from ${from} onto ${to}, but the push failed: ${pushed.stderr.trim()}`,
    moved: true,
    conflicts: [],
  };
}

/**
 * Commander's repeatable-option accumulator.
 *
 * `previous` is whatever the option's default was on the first occurrence, and
 * `unit set --scope` deliberately defaults to `undefined` — "no --scope at all"
 * has to be distinguishable from "--scope with nothing in it", because the
 * first changes nothing and the second replaces the whole list with empty.
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
 * it: the branch-create hook, the "stop if the hook refuses" rule, and making the
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
    throw CommandError.usage('unit_add', '--target is required and is never guessed: say which branch this unit delivers into. A release period and a quiet period have different answers, so there is no safe default',
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
  const { branch, from, raw } = decideBranchName(options.branch, { task, unit, round });
  checkRefName('unit_add', branch, raw);

  // Who creates depends on where the name came from. A `branch-create` hook has
  // already opened the branch — in a ticket system, on the forge, wherever the
  // team's tooling does it — so yan checks that it is really there instead of
  // cutting a second one over the top.
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
            ultimately delivered into. There is no safe default (a
            §6.4) - during a release the team merges into a shared branch, in
            quiet periods into master.
  --branch  omit it and the built-in default applies: yan/<task>-<unit>-r<n>,
            cut from --base (which defaults to --target). Give one and it is
            used as it stands - refs/heads/x, origin/x and a quoted name all
            arrive as x, so pasting what another tool printed is fine. A branch
            that already exists is adopted rather than re-cut.

A team whose branches come from somewhere else says so in a skill
(<vault>/skills/), and passes what its tooling printed to --branch.`,
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
 * Every one of these four is a decision. Who may make it is settled in the
 * instructions the main agent reads; what this command guarantees is the other
 * half — It never invents a value. Nothing here has a default, and the one
 * thing that could be guessed, how the round being replaced ended, is asked of
 * the forge rather than of the caller.
 *
 * `end` is therefore not a flag to be remembered. It is looked up:
 *
 *     merged                   → delivered
 *     closed, or mr was empty  → abandoned
 *     still open               → not over. Ask `user` first.
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
  BRANCH when it was abandoned, so the abandoned work is not lost.

Every one of these is a decision. Exit 4 means nothing was changed and \`user\`
has to answer something first.`,
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
    // started is len(history) + 2. Getting this wrong is not cosmetic: the
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
      // No outbound MR was ever opened, so nothing was delivered — but calling
      // that 'abandoned' was the single most expensive mistake in this command.
      // 'abandoned' demanded a written reason, so the cheapest and commonest
      // move ("this branch has nothing on it, give me another") was the one
      // that cost the most typing. Whether there is anything to explain is a
      // question about commits, not about merge requests, and it is answerable.
      end = 'unused';
      endFrom = 'no merge request was ever opened for it';
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
        // Not a refusal any more, and this is the heart of it. Rotating away
        // from an open MR touches nothing a colleague can see: the MR stays
        // open, the branch stays where it is, nothing is deleted or force
        // pushed, and rotating back undoes it. What was needed was not
        // permission but a loud line, which is below.
        end = 'unknown';
        endFrom = `${before.mr} was still open when the round was replaced`;
      } else {
        end = 'unknown';
        endFrom = `the forge could not say what became of ${before.mr}`;
      }
    }



    const { branch, from: nameFrom, raw } = decideBranchName(givenBranch, { task, unit: unitName, round });
    if (branch === before.branch) {
      throw CommandError.usage('unit_set', `the new integration branch is the same as the current one (${branch}) - a round is replaced by a DIFFERENT branch`,
      );
    }
    checkRefName('unit_set', branch, raw);

    // The base is not a detail. A delivered round is followed by a branch off
    // `target`, which already contains it; an abandoned round is followed by a
    // branch off the old branch itself, so the work that was dropped is still
    // there to pick over.
    //
    // A hook-created branch has no base of ours. The team's tooling cuts it
    // where the team cuts things, normally straight from the repository's main
    // branch, and yan does not get a say in that. What yan does not give up is
    // the work: carrying an abandoned round forward is its own step, run after
    // the branch is known to exist, because it is a judgement about not losing
    // commits rather than a naming rule.
    const base =
      options.base ?? (end === 'abandoned' ? before.branch : (options.target ?? before.target));
    const how = ensureBranch('yan unit set', clone, before.repo, branch, base);

    unit.rotate(end, branch, options.at ?? '');

    // after the rotation is recorded, never before. The branch exists and the
    // history is correct at this point; carrying commits forward is a separate
    // question whose failure must not undo a rotation that was right.
    //
    // It runs whenever the round being replaced still holds something the new
    // branch lacks — which is normally nothing after a delivered round, since
    // target already contains it, and is exactly the work worth saving after an
    // abandoned or unknown one.
    const carried = inheritRound(clone, before.branch, branch);
    out(`yan unit set: ${carried.said}`);
    if (carried.conflicts.length > 0) {
      // Loud, and not fatal. The same conflict is waiting in a worktree for
      // whoever picks it up, which is what a shift is for.
      out(`yan unit set: conflicting: ${carried.conflicts.join(' ')}`);
      out(`yan unit set: ${before.branch} still has that work - dispatch a shift to merge it into ${branch}, or leave it`);
    }

    const line =
      end === 'delivered'
        ? `${unitName}  delivered ${before.branch} → ${branch} (based on ${base}${options.reason ? `; ${options.reason}` : ''})`
        : `${unitName}  ${end} ${before.branch} → ${branch} (${endFrom}${options.reason ? `; ${options.reason}` : ''}) — ${carried.said}`;
    try {
      new Log(task).append(line);
    } catch {
      process.stderr.write('yan unit set: task.json was updated but log.md was not appended to\n');
    }

    // A new round rewrites the workspace tokens. The workspace is derived from
    // a live shift rather than created — a command that only wants to relabel
    // has no business making one — so a task with nothing running simply has
    // nothing on screen to relabel.
    const container = containerOf(task);
    if (container !== undefined) {
      display('could not rewrite the workspace tokens', () => {
        (terminal ?? new Terminal()).setWorkspaceTokens(container, unitTokens(task, unitName, branch));
      });
    }

    changed.push(`round ${retiring} ${end} on ${before.branch}; round ${round} is now ${branch} (${how}, name from ${nameFrom})`,
    );
  }

  // The three plain scalars run after the rotation on purpose: the history
  // entry has to record the target the retired round actually used, not the
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
