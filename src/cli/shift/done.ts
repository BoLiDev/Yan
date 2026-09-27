import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from '../shared/action.js';
import { readNote, appendLog } from '../shared/note.js';
import { cloneOf, closePane, leasesHeldBy, returnLease, type Closer } from '../shared/teardown.js';
import { remoteMrState, type MrStateReader } from '../shared/mr-state.js';
import type { WorktreePool } from '../../externals/worktree/index.js';
import { opensMr, Shift } from '../../records/shift/index.js';
import { Task } from '../../records/task/index.js';
import { YanError, isYanError } from '../../util/error.js';
import { deleteRemoteBranch, remoteBranchExists } from '../../util/git.js';

/**
 * `yan shift done` — clock a shift out, in this order:
 *
 *   0  uix work only: user has accepted it (--user-accepted)
 *   1  a coding shift's merge request is merged; any other needs outcome.md
 *   2  write outcome.md, if the shift did not
 *   3  write the log line
 *   4  rm -rf run/
 *   5  return the tree
 *   6  then delete the remote shift branch
 *   7  close the agent's pane
 *
 * Merged is the host's answer and never git ancestry, because a squash-merged
 * branch is not an ancestor of what it landed on. The tree goes back before
 * the branch is deleted: deleting first drops the remote-tracking ref, and the
 * pool's orphan-commit guard would then refuse the return and strand the slot.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 4 the merge request has not
 * merged so there is nothing to clock out yet, 1 anything else.
 */

const RC_NOT_MERGED = 4;

export interface ClockOutOptions {
  task?: string;
  mr?: string;
  outcome?: string;
  note?: string;
  keepPane?: boolean;
  userAccepted?: boolean;
  /** A coding shift concluded that nothing needs merging; its outcome.md is the deliverable. */
  nothingToMerge?: boolean;
  json?: boolean;
}

export interface ClockOutDeps {
  readonly terminal?: Closer;
  readonly pool?: (clone: string) => Pick<WorktreePool, 'return' | 'status'>;
  readonly mrStateOf?: MrStateReader;
  readonly deleteBranch?: (clone: string, branch: string) => boolean;
  /** Asked only on a resume that cannot tell whether the branch was ever pushed. */
  readonly onOrigin?: (clone: string, branch: string) => boolean;
}

interface ClockOutResult {
  readonly version: 1;
  readonly sid: string;
  readonly task: string;
  readonly unit: string;
  readonly branch: string;
  /**
   * The last round's merge request, or '' for a scenario that opens none. On a
   * resume it is the one the stopped attempt accepted, or for a shift from
   * before teardown.json, whatever URL outcome.md names.
   */
  readonly mr: string;
  /**
   * `unknown` only on the resume of a shift dispatched before teardown.json,
   * which is the one place its scenario outlives run/: nothing then says
   * whether it opened a merge request at all.
   */
  readonly mr_state: 'merged' | 'none' | 'unknown';
  /** `unknown` in the same case. */
  readonly scenario: string;
  readonly tree: string;
  readonly outcome_by: string;
  readonly run_removed: true;
  readonly tree_returned: boolean;
  readonly branch_deleted: boolean;
  /** False when the agent was still in its pane after the close; the pane is then named in `pane`. */
  readonly pane_closed: boolean;
  readonly pane: string;
}

/**
 * The lease this shift still holds, found by asking every unit's pool for the
 * holder `<task>/<unit>/<sid>`. `undefined` means it clocked out cleanly;
 * anything else means a teardown stopped before the tree came back.
 */
function resumeFromPool(
  task: string,
  sid: string,
  deps: ClockOutDeps,
): { unit: string; clone: string; path: string; branch: string; holder: string; leaseId: string } | undefined {
  if (task === '' || !Task.exists(task)) return undefined;
  // The holders are built from task.json rather than parsed out of the lease:
  // which unit a tree belongs to is the document's answer, not a name's.
  const units = new Map(new Task(task).read().units.map((u) => [`${task}/${u.name}/${sid}`, u.name]));
  for (const lease of leasesHeldBy(task, deps.pool)) {
    const unit = units.get(lease.holder);
    if (unit === undefined) continue;
    return {
      unit,
      clone: lease.clone,
      path: lease.path,
      branch: lease.branch,
      holder: lease.holder,
      leaseId: lease.lease_id,
    };
  }
  return undefined;
}

/** What a clock-out tears down, read once, before any of it is. */
interface TeardownTarget {
  readonly unit: string;
  /** The shift branch. */
  readonly branch: string;
  readonly tree: string;
  readonly clone: string;
  readonly holder: string;
  readonly leaseId: string;
  /** '' on a resume: the pane was recorded in run/ alone. */
  readonly pane: string;
  /** `undefined` only on the resume of a shift dispatched before teardown.json. */
  readonly scenario: string | undefined;
  /** On a resume, what the stopped attempt decided about the merge request, when it recorded that. */
  readonly concluded: { readonly mr: string; readonly mrState: 'merged' | 'none' } | undefined;
  readonly resuming: boolean;
}

/**
 * Read what the clock-out tears down: from `run/meta.json` while the shift is
 * live, and from the pool and `teardown.json` when `run/` is gone but a tree is
 * still leased, which is a teardown that stopped at the tree return.
 *
 * @throws YanError `shift_done_usage` when run/ is gone and no tree is leased either.
 */
function teardownTarget(shift: Shift, deps: ClockOutDeps): TeardownTarget {
  if (shift.isLive()) {
    const meta = shift.meta();
    const unit = meta.unit ?? '';
    return {
      unit,
      branch: meta.branch ?? '',
      tree: meta.tree ?? '',
      // The fallback for a shift dispatched before meta.json recorded the clone.
      clone: meta.clone ?? cloneOf(shift.task, unit),
      holder: meta.holder ?? '',
      leaseId: meta.lease_id ?? '',
      pane: meta.pane ?? '',
      scenario: meta.scenario,
      concluded: undefined,
      resuming: false,
    };
  }

  const lease = resumeFromPool(shift.task, shift.sid, deps);
  if (lease === undefined) {
    throw YanError.usage('shift_done_usage', `shift ${shift.label()} has already clocked out - run/ is gone, which is the fact that says so`,
    );
  }
  process.stderr.write(`yan shift done: ${shift.label()} left a tree leased - finishing the teardown that stopped at the tree return\n`,
  );
  const record = shift.teardown();
  return {
    unit: lease.unit,
    branch: lease.branch,
    tree: lease.path,
    clone: lease.clone !== '' ? lease.clone : cloneOf(shift.task, lease.unit),
    holder: lease.holder,
    leaseId: lease.leaseId,
    pane: '',
    scenario: record?.scenario,
    concluded: record?.mr_state === undefined ? undefined : { mr: record.mr ?? '', mrState: record.mr_state },
    resuming: true,
  };
}

/**
 * Clock a shift out, resuming an interrupted teardown when `run/` is already
 * gone but a tree is still leased.
 *
 * @throws YanError `shift_done_usage` for a missing sid, an unknown outcome file, no
 *   recorded merge request, or a shift that has fully clocked out;
 *   `shift_done_not_merged` (exit 4) when the host says it has not merged;
 *   `shift_done_return_refused` when the tree could not go back, in which case the remote
 *   branch is left alone.
 */
export function clockOut(sid: string | undefined, options: ClockOutOptions, deps: ClockOutDeps = {}): ClockOutResult {
  if (sid === undefined || sid === '') {
    throw YanError.usage('shift_done_usage', 'a shift id is required');
  }
  if (options.outcome !== undefined && !existsSync(options.outcome)) {
    throw YanError.usage('shift_done_usage', `no such outcome file: ${options.outcome}`);
  }
  const note = readNote('shift_done', options.note);

  const shift = Shift.resolve(sid, options.task ?? '');
  const target = teardownTarget(shift, deps);
  const { unit, branch, tree, clone, scenario, resuming } = target;
  if (branch === '') {
    throw new YanError('shift_done_no_branch', `run/meta.json does not say which shift branch ${shift.label()} is on - it cannot be cleaned up automatically`,
    );
  }

  // The shift opens its own MR, so the URL usually arrives on its `done` event.
  let mr = options.mr ?? (resuming ? (target.concluded?.mr ?? '') : shift.openedMr());

  const outcomeFile = join(shift.dir, 'outcome.md');
  let outcomeBy: string;

  // Merging is the floor for coding, not the definition of done - whether the
  // merged work is accepted is yan's and user's judgement - unless the shift
  // concluded that nothing needs merging, which user says with the flag.
  const needsMerge = !resuming && opensMr(scenario ?? '') && options.nothingToMerge !== true;

  // What became of the merge request. A resume takes what the stopped attempt
  // decided; without that, a scenario that opens none still says so.
  const mrState: ClockOutResult['mr_state'] = !resuming
    ? needsMerge ? 'merged' : 'none'
    : target.concluded !== undefined
      ? target.concluded.mrState
      : scenario !== undefined && !opensMr(scenario) ? 'none' : 'unknown';

  // Steps 1 to 4 already ran in the attempt that stopped, so a resume starts
  // at the tree return.
  if (!resuming) {
    // --- 0. accepted, and by whom -------------------------------------------
    // Clocking out is the statement that the work is accepted. Interface work
    // is accepted by user alone, so that is a flag rather than a judgement.
    if (scenario === 'uix' && options.userAccepted !== true) {
      throw new YanError('shift_done_needs_user', `${shift.label()} is uix work, and only user accepts it - nothing was clocked out. When they have said they are satisfied, re-run with --user-accepted`,
        { exitCode: RC_NOT_MERGED },
      );
    }

    // --- 1. is its last round merged? ---------------------------------------
    if (needsMerge) {
      if (mr === '') {
        throw YanError.usage('shift_done_usage', `no merge request recorded for ${shift.label()} - pass --mr <url>. Whether the work landed is the host's answer, and yan will not guess it from git history`,
        );
      }
      const dir = tree !== '' && existsSync(tree) ? tree : clone !== '' && existsSync(clone) ? clone : undefined;
      // Not `mrStateOrUnknown`: a forge that is not configured says so here,
      // where the gate is, rather than surfacing as "'unknown', not merged".
      const state = (deps.mrStateOf ?? remoteMrState)({ mr, dir });
      if (state !== 'merged') {
        throw new YanError('shift_done_not_merged', `${mr} is '${state}', not merged - a shift clocks out once its last round's merge request has merged into the integration branch, and nothing sooner`,
          { exitCode: RC_NOT_MERGED },
        );
      }
    } else {
      // An explore or uix shift opens no merge request, and a coding shift
      // that had nothing to merge has none either; what it delivered is its
      // handover, and without one there is nothing to have accepted.
      mr = '';
      if (!existsSync(outcomeFile) && options.outcome === undefined) {
        throw new YanError('shift_done_no_outcome', `${shift.label()} is ${options.nothingToMerge === true ? 'a coding shift with nothing to merge' : `${scenario === 'uix' ? 'a' : 'an'} ${scenario ?? ''} shift`} and has written no outcome.md - there is no deliverable to accept yet. Pass --outcome <file> if its report lives elsewhere`,
          { exitCode: RC_NOT_MERGED },
        );
      }
    }

    // --- 2. outcome.md ------------------------------------------------------
    // The shift writes this itself; what follows is the fallback for one that
    // did not, and it is recorded as yan's rather than the shift's.
    if (existsSync(outcomeFile)) {
      outcomeBy = 'shift';
    } else if (options.outcome !== undefined) {
      outcomeBy = 'yan';
      writeFileSync(outcomeFile, readFileSync(options.outcome, 'utf8'));
    } else {
      outcomeBy = 'yan';
      writeFileSync(
        outcomeFile,
        [
          `# ${shift.sid} ${unit}`,
          '',
          `- shift branch: ${branch}`,
          `- merge request: ${mr} (merged)`,
          `- events reported: ${shift.eventCount()}`,
          '',
          'Written by yan when the shift clocked out: the shift did not leave an',
          'outcome of its own, so this records only what could be observed.',
          '',
        ].join('\n'),
      );
    }

    // --- 3. the log line ----------------------------------------------------
    if (shift.task !== '') {
      const what = needsMerge
        ? `${mr} merged into the integration branch`
        : options.nothingToMerge === true ? 'nothing to merge, report accepted' : scenario === 'uix' ? 'artifacts accepted by user' : 'report accepted';
      appendLog('yan shift done', shift.task, 'delivered', `${shift.sid} ${unit}  ${what}`, note);
    }

    // --- 4. rm -rf run/, the whole throwaway layer --------------------------
    // What was decided goes outside it first, so a teardown that stops below
    // is finished knowing whether there is a branch to delete.
    shift.writeTeardown({ version: 1, scenario: scenario ?? '', unit, branch, clone, mr, mr_state: needsMerge ? 'merged' : 'none' });
    rmSync(shift.run, { recursive: true, force: true });
  } else {
    // Resuming: outcome.md survived from the stopped attempt's step 2. A shift
    // from before teardown.json may name its merge request there.
    outcomeBy = existsSync(outcomeFile) ? 'written earlier' : 'missing';
    if (mr === '' && mrState === 'unknown' && existsSync(outcomeFile)) {
      mr = /https?:\/\/\S+/.exec(readFileSync(outcomeFile, 'utf8'))?.[0] ?? '';
    }
  }

  // --- 5. return the tree, before the branch is deleted ---------------------
  let returned = '';
  if (tree === '') {
    process.stderr.write(`yan shift done: no worktree recorded for ${shift.label()}, so there is none to return\n`);
  } else if (clone === '') {
    process.stderr.write(`yan shift done: the main clone of ${shift.label()} is not recorded, so the tree at ${tree} must be returned by hand\n`,
    );
  } else {
    const back = returnLease(clone, tree, { leaseId: target.leaseId, holder: target.holder }, deps.pool);
    if (!back.returned) {
      // Fatal: a refusal here means the commits may exist nowhere else, and
      // deleting the remote branch next would make that permanent.
      throw new YanError('shift_done_return_refused', `the tree at ${tree} could not be returned, so the remote branch ${branch} has NOT been deleted - investigate before anything else touches it (${back.reason ?? ''})`,
        { exitCode: isYanError(back.cause) ? back.cause.exitCode : 1, cause: back.cause },
      );
    }
    returned = back.path;
  }

  // --- 6. and only now, the remote shift branch -----------------------------
  let deleted = false;
  // Only a merged merge request's branch is yan's to delete: a branch a shift
  // pushed without one is left for somebody to look at. A resume of a shift
  // from before teardown.json cannot tell, so it asks origin whether there is
  // a branch at all.
  const onOrigin = deps.onOrigin ?? ((c: string, b: string) => remoteBranchExists(c, b));
  const cloneThere = clone !== '' && existsSync(clone);
  const pushed = mrState === 'merged' || (mrState === 'unknown' && cloneThere && onOrigin(clone, branch));
  if (pushed && cloneThere) {
    const drop =
      deps.deleteBranch ?? ((c: string, b: string) => deleteRemoteBranch(c, 'origin', b).code === 0);
    deleted = drop(clone, branch);
    if (!deleted) {
      process.stderr.write(`yan shift done: the remote branch ${branch} could not be deleted (it may already be gone) - the tree is back in the pool either way\n`,
      );
    }
  }

  // --- 7. the agent's pane, and then whether the agent really went ----------
  // Never fatal to the teardown, which is done by now; an agent still running
  // is reported as a failure of the command, because nobody else will notice.
  const paneClosed = options.keepPane === true ? true : closePane(target.pane, deps.terminal);

  return {
    version: 1,
    sid: shift.sid,
    task: shift.task,
    unit,
    branch,
    mr,
    mr_state: mrState,
    scenario: scenario ?? 'unknown',
    tree: returned !== '' ? returned : tree,
    outcome_by: outcomeBy,
    run_removed: true,
    tree_returned: returned !== '',
    branch_deleted: deleted,
    pane_closed: paneClosed,
    pane: target.pane,
  };
}

export const doneShift = new Command('done')
  .description('clock a shift out once its work is accepted')
  .argument('[sid]')
  .option('--mr <url>', "the last round's merge request, when the shift reported none")
  .option('--outcome <file>', 'a file whose contents become outcome.md if the shift wrote none')
  .option('--note <text>', 'one line for log.md: what the accepted work changed')
  .option('--user-accepted', 'user has said they are satisfied - required for uix work')
  .option('--nothing-to-merge', 'a coding shift concluded that no change is needed; its outcome.md is accepted instead of a merge request')
  .option('--keep-pane', "leave the agent's pane open")
  .option('--json', "print the teardown record instead of a summary; mr_state is merged, none, or unknown after resuming a shift from before teardown.json")
  .addHelpText(
    'after',
    `
Running it says the shift's work is accepted: a shift carries on through as
many rounds of rework as that takes, and is clocked out once, at the end. uix
work is accepted by user alone, so it needs --user-accepted.

A coding shift clocks out once its last round's merge request has merged -
the floor, not the definition, of accepted - or with --nothing-to-merge when
it concluded that no change is needed, in the one order that survives a
squash merge:

  merged -> outcome.md -> the log line -> rm -rf run/ -> return the tree
    -> delete the remote shift branch -> close the pane

An explore or uix shift opens none, and needs its outcome.md instead. Whether
a request merged is asked of the host, never inferred from git ancestry.

A teardown that stopped at the tree return is finished by running it again.
run/ is gone by then, but teardown.json beside it says what the shift was and
whether its merge request merged, so the remote branch is deleted only when it
did. A shift dispatched before teardown.json existed is reported with
scenario and mr_state 'unknown', and its branch is deleted when origin has one.

Exit code 4 means nothing was clocked out yet: the merge request has not
merged, the report is missing, or user has not accepted uix work. Exit code 1
after a teardown means the agent was still in its pane after closing it.`,
  )
  .action(
    action('yan shift done', (sid: string | undefined, options: ClockOutOptions) => {
      const r = clockOut(sid, options);
      if (options.json === true) {
        out(JSON.stringify(r));
      } else {
        out(`${r.sid} clocked out`);
        if (r.mr_state === 'merged') out(`mr       ${r.mr} (merged)`);
        if (r.mr_state === 'unknown' && r.mr !== '') out(`mr       ${r.mr} (from outcome.md)`);
        out(`outcome  ${join(new Shift(r.task, r.sid).dir, 'outcome.md')} (${r.outcome_by})`);
        out('run      removed');
        out(`tree     ${r.tree_returned ? r.tree : 'not returned'}`);
        if (r.mr_state === 'merged') out(`branch   ${r.branch} ${r.branch_deleted ? 'deleted on origin' : 'left on origin'}`);
        if (r.mr_state === 'unknown') out(`branch   ${r.branch} ${r.branch_deleted ? 'deleted on origin' : 'not deleted on origin'}`);
      }
      if (!r.pane_closed) {
        process.stderr.write(`yan shift done: the agent in ${r.pane} was still running after its pane was closed - close ${r.pane} by hand\n`);
        process.exitCode = 1;
      }
    }),
  );
