import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { containerOf } from './shared/container.js';
import { display, unitTokens } from './shared/display.js';
import { repoDir } from './shared/repo.js';
import { Terminal } from '../externals/herdr/index.js';
import { RemoteGit, type MrState } from '../externals/remote-git/index.js';
import { Log } from '../records/log/index.js';
import { Task } from '../records/task/index.js';
import { branchExists, commitTree, createBranch, fetch, gitLines, gitOk, mergeTree, push, revParse, updateRef } from '../util/git.js';

/**
 * `yan unit add` / `yan unit set`.
 *
 * `target` is never defaulted by either command. A unit's branch is named one
 * of two ways:
 *
 *   default   yan names it `yan/<task>-<unit>-r<n>`
 *   --branch  you name it, in whatever spelling your tooling printed
 *
 * Either way yan makes it exist, adopting a local or remote branch of that
 * name before cutting one. Everything it cuts is a ref, never a checkout, so
 * whoever is working in the main clone stays on their branch.
 */

/** What the built-in name is made of. */
interface BranchNameContext {
  readonly task: string;
  readonly unit: string;
  readonly round: number;
}

type NameSource = 'user' | 'default';

/** `given` normalised when there is one, otherwise the built-in name. */
function decideBranchName(
  given: string | undefined,
  context: BranchNameContext,
): { branch: string; from: NameSource; raw?: string } {
  if (given !== undefined && given !== '') {
    return { branch: normalizeBranchName(given), from: 'user', raw: given };
  }
  return { branch: `yan/${context.task}-${context.unit}-r${context.round}`, from: 'default' };
}


/**
 * A branch name as a tool may have printed it — `refs/heads/x`, `origin/x`,
 * quoted, or with a trailing CR — reduced to the plain name.
 */
export function normalizeBranchName(raw: string): string {
  let name = raw.trim().replace(/\r/g, '');
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
    name = name.slice(1, -1).trim();
  }
  name = name.replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  return name.trim();
}

/**
 * @throws CommandError `usage` when `branch` is unusable as a git ref. The
 *   message quotes `raw` too, so a hook's own output is recognisable.
 */
function checkRefName(command: string, branch: string, raw?: string): void {
  const bad = branch === '' || /\s/.test(branch) || branch.startsWith('-') || branch.endsWith('/');
  if (bad) {
    const from = raw !== undefined && raw !== branch ? ` (from '${raw}')` : '';
    throw CommandError.usage(command, `'${branch}'${from} is not usable as a git ref - fix the hook, or pass --branch`,
    );
  }
}

/**
 * `origin/<branch>` when it resolves, otherwise `''`. Preferred over a local
 * ref of the same name, which a main clone never pulls into.
 */
function remoteRef(clone: string, branch: string): string {
  return gitOk(clone, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
    ? `origin/${branch}`
    : '';
}

/**
 * Bring a main clone's `origin/*` refs up to date. Warns rather than throwing
 * when the network is not there. Call it once per clone: nothing below
 * fetches.
 */
export function freshenClone(command: string, clone: string, repo: string): void {
  if (fetch(clone).code !== 0) {
    process.stderr.write(`${command}: could not fetch ${repo} - working from the refs already in the clone\n`);
  }
}

/**
 * Make `branch` exist in the clone as a ref, adopting a local or remote one of
 * that name before cutting a new one from `base`. Returns a line saying which
 * happened. Never fetches and never checks anything out.
 *
 * @throws CommandError `branch_failed` or `base_unresolved`.
 */
function ensureBranch(command: string, clone: string, branch: string, base: string): string {
  if (branchExists(clone, branch)) return 'adopted the existing local branch';

  if (remoteRef(clone, branch) !== '') {
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
  /** Paths git could not merge. Non-empty means nothing was carried. */
  readonly conflicts: readonly string[];
}

/**
 * Merge the round being replaced onto the new integration branch, and push it.
 *
 * Runs entirely in the main clone: `merge-tree --write-tree` writes objects
 * and refs and never checks anything out, so no tree is leased and nothing is
 * left half-done. Never throws — a conflict, a failed commit or a failed push
 * all come back in `said`, with `moved` false.
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

/** Commander's repeatable-option accumulator. */
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
  /** The caller has already fetched this unit's clone, so this must not. */
  fetched?: boolean;
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
 * `yan unit add` without the process around it: name the branch, make it
 * exist, record the unit, append the log line.
 *
 * @throws CommandError `usage` for a missing argument or unknown task,
 *   `exists` when the unit is already there, `not_recorded` when the branch
 *   was made but task.json could not be written.
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

  // A unit being added has no history, so its round is always the first.
  const round = 1;
  const { branch, from, raw } = decideBranchName(options.branch, { task, unit, round });
  checkRefName('unit_add', branch, raw);

  if (options.fetched !== true) freshenClone('yan unit add', clone, repo);
  const how = ensureBranch('yan unit add', clone, branch, options.base ?? target);

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
 * `yan unit set`. Nothing here is defaulted, and how the round being replaced
 * ended is asked of the forge rather than of the caller, unless `--end` says:
 *
 *     merged                   → delivered
 *     closed                   → abandoned
 *     no merge request opened  → unused
 *     open, or unreachable     → unknown
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
 */
export type MrStateReader = (mr: string, dir: string) => MrState;

/** What `unit set` reports to Herdr. Display only, and never fatal. */
export interface Labeller {
  setWorkspaceTokens(workspace: string, tokens: Record<string, string>): void;
  /** How the workspace to label is found, when no shift has recorded one. */
  workspaceOfPane(pane: string): string | undefined;
}

const set = new Command('set')
  .description("change a unit's branch, target, mode or scope")
  .option('--task <id>', 'the task the unit belongs to')
  .option('--unit <name>', 'the unit name')
  // Bare `--branch` starts a new round under the built-in name; with a value
  // it starts one under that name.
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

/**
 * `yan unit set` without the process around it. `--branch` rotates the unit:
 * it archives the current round under an `end` it works out, makes the new
 * branch exist, carries any un-landed commits forward, and relabels the
 * workspace. Narrates to stdout.
 *
 * @throws CommandError `usage` for a missing argument, nothing to change, an
 *   unknown task or unit, or a new branch equal to the current one;
 *   `no_branch` when there is no round to replace.
 */
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
    // The rotation appends one history entry, so the round being started is
    // two past what history holds now.
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
      end = 'unused';
      endFrom = 'no merge request was ever opened for it';
    } else {
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

    // An abandoned round is followed by a branch off the old branch, so the
    // dropped work is still there to pick over; anything else off the target.
    const base =
      options.base ?? (end === 'abandoned' ? before.branch : (options.target ?? before.target));
    freshenClone('yan unit set', clone, before.repo);
    const how = ensureBranch('yan unit set', clone, branch, base);

    unit.rotate(end, branch, options.at ?? '');

    // After the rotation is recorded, so a failure here cannot undo it.
    const carried = inheritRound(clone, before.branch, branch);
    out(`yan unit set: ${carried.said}`);
    if (carried.conflicts.length > 0) {
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

    // A task with nothing on screen has no workspace, and none is created.
    const labeller = terminal ?? new Terminal();
    const container = containerOf(task, labeller);
    if (container !== undefined) {
      display('could not rewrite the workspace tokens', () => {
        labeller.setWorkspaceTokens(container, unitTokens(task, unitName, branch));
      });
    }

    changed.push(`round ${retiring} ${end} on ${before.branch}; round ${round} is now ${branch} (${how}, name from ${nameFrom})`,
    );
  }

  // After the rotation, so the history entry records the target the retired
  // round used rather than the new one.
  if (options.target) {
    const old = unit.read().target;
    unit.set('target', options.target);
    try {
      new Log(task).append(`${unitName}  target ${old} → ${options.target}`);
    } catch { /* the change is recorded; a missing log line is not worth failing for */ }
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
