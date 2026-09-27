import { Command } from 'commander';
import { action, out, collect } from './shared/action.js';
import { containerOf } from './shared/container.js';
import { display, unitTokens } from './shared/display.js';
import { readNote, appendLog } from './shared/note.js';
import { repoDir } from './shared/repo.js';
import { insideTask, existingTask } from './shared/task-id.js';
import { checkRefName, decideBranchName, ensureBranch, freshenClone, inheritRound } from './shared/branch.js';
import { addTaskUnit, type AddOptions } from './shared/unit-add.js';
import { Terminal } from '../externals/herdr/index.js';
import { RemoteGit, type MrState } from '../externals/remote-git/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan unit add` / `yan unit set`.
 *
 * `target` is never defaulted by either command. How a unit's branch is named
 * and made to exist is in `shared/branch.ts`.
 */

// --- unit add ---------------------------------------------------------------

const add = new Command('add')
  .description('add a unit and make its integration branch exist')
  .option('--unit <name>', 'the unit name')
  .option('--repo <repo>', 'a repository under repos/, or the path to a clone')
  .option('--target <branch>', 'REQUIRED: which branch this unit delivers into')
  .option('--branch <name>', "the integration branch's name")
  .option('--base <ref>', 'what to cut the branch from when it does not exist (default: --target)')
  .option('--scope <path>', 'repeatable; the paths this unit may touch', collect, [])
  .option('--needs <unit>', 'repeatable; unit names that must land before this one', collect, [])
  .option('--note <text>', 'one line for log.md: why this unit exists')
  .option('--json', 'machine readable output')
  .addHelpText(
    'after',
    `
  --target  REQUIRED, and never defaulted: which branch this unit's work is
            ultimately delivered into. There is no safe default - during a
            release the team merges into a shared branch, in quiet periods
            into the default one.
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

interface SetOptions {
  task?: string;
  unit?: string;
  branch?: string | boolean;
  target?: string;
  base?: string;
  end?: string;
  reason?: string;
  at?: string;
  scope?: string[];
  needs?: string[];
  note?: string;
  json?: boolean;
}

/**
 * What `unit set` needs from the remote host: how the round being replaced
 * ended. `RemoteGit` is the real one.
 */
type MrStateReader = (mr: string, dir: string) => MrState;

/** What `unit set` reports to Herdr. Display only, and never fatal. */
export interface Labeller {
  setWorkspaceTokens(workspace: string, tokens: Record<string, string>): void;
  /** How the workspace to label is found, when no shift has recorded one. */
  workspaceOfPane(pane: string): string | undefined;
}

const set = new Command('set')
  .description("change a unit's branch, target, scope or needs")
  .option('--unit <name>', 'the unit name')
  // Bare `--branch` starts a new round under the built-in name; with a value
  // it starts one under that name.
  .option('--branch [name]', 'start a NEW ROUND on that integration branch')
  .option('--target <branch>', 'where this unit delivers')
  .option('--base <ref>', 'what to cut the new branch from when it does not exist')
  .option('--end <end>', 'delivered | abandoned - how the round being replaced finished')
  .option('--reason <text>', 'why, appended to the log line')
  .option('--at <date>', 'the retirement date recorded in history[] (default: today)')
  .option('--scope <path>', 'repeatable; REPLACES the whole scope list', collect, undefined)
  .option('--needs <unit>', 'repeatable; REPLACES the whole needs list', collect, undefined)
  .option('--note <text>', 'one line for log.md: why this changed')
  .option('--json', 'print the unit as it now stands')
  .addHelpText(
    'after',
    `
  --base defaults to --target when the old round was delivered, and to the OLD
  BRANCH when it was abandoned, so the abandoned work is not lost.

Every one of these is a decision, and --note is where its reason goes: it is
appended to each line this writes to log.md. --needs '' clears the list.`,
  )
  .action(action('yan unit set', (options: SetOptions) => setUnit(options)));

/**
 * `yan unit set` without the process around it. `--branch` rotates the unit:
 * it archives the current round under an `end` it works out, makes the new
 * branch exist, carries any un-landed commits forward, and relabels the
 * workspace. Narrates to stdout.
 *
 * @throws YanError `unit_set_usage` for a missing argument, nothing to change, an
 *   unknown task or unit, or a new branch equal to the current one;
 *   `unit_set_no_branch` when there is no round to replace.
 */
export function setUnit(options: SetOptions, readMrState?: MrStateReader, terminal?: Labeller): void {
  const task = options.task ?? insideTask('unit_set');
  const unitName = options.unit ?? '';
  const wantBranch = options.branch !== undefined;
  const givenBranch = typeof options.branch === 'string' ? options.branch : undefined;
  const wantScope = options.scope !== undefined;
  const wantNeeds = options.needs !== undefined;

  if (unitName === '') throw YanError.usage('unit_set_usage', '--unit is required');
  if (!wantBranch && !options.target && !wantScope && !wantNeeds) {
    throw YanError.usage('unit_set_usage', 'nothing to change - pass --branch, --target, --scope or --needs');
  }
  const note = readNote('unit_set', options.note);
  const end0 = options.end ?? '';
  if (end0 !== '' && end0 !== 'delivered' && end0 !== 'abandoned') {
    throw YanError.usage('unit_set_usage', `--end is 'delivered' or 'abandoned', not '${end0}'`);
  }
  if (end0 !== '' && !wantBranch) {
    throw YanError.usage('unit_set_usage', '--end only applies to --branch: it says how the round being replaced finished');
  }

  const record = existingTask('unit_set', task);
  if (record.findUnit(unitName) === undefined) {
    throw YanError.usage('unit_set_usage', `no such unit: ${unitName} in ${task}`);
  }
  const needs = (options.needs ?? []).filter((n) => n !== '');
  if (wantNeeds) {
    const known = record.read().units.map((u) => u.name);
    const unknown = needs.filter((n) => !known.includes(n));
    if (unknown.length > 0) {
      throw YanError.usage('unit_set_usage', `--needs names no unit of ${task}: ${unknown.join(' ')}`);
    }
    if (needs.includes(unitName)) {
      throw YanError.usage('unit_set_usage', `a unit cannot need itself: ${unitName}`);
    }
  }

  const changed: string[] = [];

  if (wantBranch) {
    const before = record.unit(unitName);
    const clone = repoDir('unit_set', before.repo, 'the unit names it, but nothing on this machine says where it is');
    // The rotation appends one history entry, so the round being started is
    // two past what history holds now.
    const retiring = before.history.length + 1;
    const round = before.history.length + 2;

    if (before.branch === '') {
      throw new YanError('unit_set_no_branch', "this unit has no current branch to replace - 'yan unit add' should have set one",
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
      throw YanError.usage('unit_set_usage', `the new integration branch is the same as the current one (${branch}) - a round is replaced by a DIFFERENT branch`,
      );
    }
    checkRefName('unit_set', branch, raw);

    // An abandoned round is followed by a branch off the old branch, so the
    // dropped work is still there to pick over; anything else off the target.
    const base =
      options.base ?? (end === 'abandoned' ? before.branch : (options.target ?? before.target));
    freshenClone('yan unit set', clone, before.repo);
    const how = ensureBranch('yan unit set', clone, branch, base);

    record.rotateUnit(unitName, end, branch, options.at ?? '');

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
    appendLog('yan unit set', task, 'changed', line, note);

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
    const old = record.unit(unitName).target;
    const target = options.target;
    record.editUnit(unitName, (u) => {
      u.target = target;
    });
    appendLog('yan unit set', task, 'changed', `${unitName}  target ${old} → ${options.target}`, note);
    changed.push(`target=${options.target}`);
  }

  if (wantScope) {
    const scope = options.scope ?? [];
    record.editUnit(unitName, (u) => {
      u.scope = [...scope];
    });
    appendLog('yan unit set', task, 'changed', `${unitName}  scope → ${scope.join(' ')}`, note);
    changed.push(`scope=${scope.join(' ')}`);
  }

  if (wantNeeds) {
    record.editUnit(unitName, (u) => {
      u.needs = [...needs];
    });
    appendLog('yan unit set', task, 'changed', `${unitName}  needs → ${needs.length > 0 ? needs.join(' ') : '(none)'}`, note);
    changed.push(`needs=${needs.join(' ')}`);
  }

  if (options.json === true) out(JSON.stringify(record.unit(unitName), null, 2));
  else out(`${task} ${unitName}  ${changed.join(' ')}`);
}

export const command = new Command('unit')
  .description("a task's units")
  .addCommand(add)
  .addCommand(set);
