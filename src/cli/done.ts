import { rmSync } from 'node:fs';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { closePane, leasesHeldBy, returnLease } from './shared/teardown.js';
import { isTty } from './shared/resolve.js';
import { openTasks } from './shared/task-id.js';
import type { Closer } from './shared/terminal.js';
import { YanError, isYanError } from '../util/error.js';
import { Terminal } from '../externals/herdr/index.js';
import type { WorktreePool } from '../externals/worktree/index.js';
import { Log } from '../records/log/index.js';
import { Shift } from '../records/shift/index.js';
import { Task } from '../records/task/index.js';

/**
 * `yan done [<id>]` — mark a task complete and give its trees back, which are
 * one event: a finished task whose trees are still leased shrinks the pool.
 *
 * Which trees belong to the task is asked of the pool, whose holder is
 * `<task>/<unit>/<sid>`, so a tree left behind by a teardown that stopped
 * halfway is found too. `run/` is read for one thing only: which pane an agent
 * is in.
 *
 * Which task: an explicit id, then `$YAN_TASK`, then a multi-select when
 * there is a tty, then a refusal. Several tasks are all
 * attempted and all reported, and the exit code is the first failure's.
 *
 * Without `--force` it refuses rather than destroys. With it, live shifts are
 * killed and every tree is wiped past the orphan-commit guard: uncommitted
 * changes and untracked files go, commits stay on the shift branch in the
 * clone. Only `user` may ask for it, and the prompt never offers it.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 4 a shift is still live,
 * 5 a tree could not be returned, 1 anything else.
 */

const RC_LIVE_SHIFTS = 4;
const RC_TREE_HELD = 5;

export interface DoneOptions {
  task?: string;
  force?: boolean;
  json?: boolean;
}

export interface DoneDeps {
  readonly terminal?: Closer;
  readonly pool?: (clone: string) => Pick<WorktreePool, 'return' | 'status'>;
}

interface KilledShift {
  readonly sid: string;
  readonly unit: string;
  readonly pane_closed: boolean;
}

interface ReturnedTree {
  readonly holder: string;
  readonly path: string;
  readonly returned: boolean;
  readonly reason?: string;
}

export interface DoneResult {
  readonly version: 1;
  readonly task: string;
  readonly title: string;
  readonly complete: boolean;
  readonly was_complete: boolean;
  readonly forced: boolean;
  readonly killed: readonly KilledShift[];
  readonly trees: readonly ReturnedTree[];
}

/**
 * Close a live shift's pane and delete its `run/`, leaving outcome.md, the
 * status log and the brief. Never throws for a pane it cannot close.
 */
function kill(shift: Shift, terminal: Closer): KilledShift {
  const meta = shift.meta();
  const pane = meta.pane ?? '';
  const closed = closePane(pane, terminal);
  rmSync(shift.run, { recursive: true, force: true });
  return { sid: shift.sid, unit: meta.unit ?? '', pane_closed: pane !== '' && closed };
}

/**
 * Finish one task: return its trees and mark it complete.
 *
 * @throws YanError `done_usage` when no task is named, `done_missing` for an unknown
 *   one, `done_live_shifts` (exit 4) when a shift is still live and `--force` was
 *   not given — nothing is touched in that case — and `done_tree_held` (exit 5)
 *   when a tree would not come back, after the others have been returned.
 */
export function finishTask(options: DoneOptions, deps: DoneDeps = {}): DoneResult {
  const task = options.task ?? process.env.YAN_TASK ?? '';
  if (task === '') {
    throw YanError.usage('done_usage', 'which task? pass it as the argument, or set $YAN_TASK');
  }
  if (!Task.exists(task)) {
    const where = Task.isId(task) ? new Task(task).file : `${task}/task.json`;
    throw new YanError('done_missing', `no such task: ${task} - ${where} does not exist`);
  }

  const record = new Task(task);
  const wasComplete = record.isComplete();
  const force = options.force === true;

  // --- 1. live shifts, before anything is touched ---------------------------
  const live = Shift.liveIn(task);
  if (live.length > 0 && !force) {
    const named = live
      .map((s) => {
        const unit = s.meta().unit ?? '';
        return unit === '' ? s.sid : `${s.sid} (${unit})`;
      })
      .join(', ');
    throw new YanError('done_live_shifts', `${task} still has live shifts: ${named}\n    they are holding trees and may be mid-edit. Clock them out with 'yan shift done <sid>' once their work is accepted, or - if user is giving the task up - 'yan abandon ${task} --user-asked --reason ...', which closes their merge requests too; --force instead marks it done and discards their work`,
      { exitCode: RC_LIVE_SHIFTS },
    );
  }

  // --- 2. with --force, kill them, and read the pool after -------------------
  const terminal = deps.terminal ?? new Terminal();
  const killed = force ? live.map((s) => kill(s, terminal)) : [];

  // --- 3. the trees ----------------------------------------------------------
  const trees: ReturnedTree[] = [];
  for (const lease of leasesHeldBy(task, deps.pool)) {
    const back = returnLease(
      lease.clone,
      lease.path,
      { leaseId: lease.lease_id, holder: lease.holder, force },
      deps.pool,
    );
    trees.push({ holder: lease.holder, ...back });
  }
  const stuck = trees.filter((t) => !t.returned);

  // --- 4. and only now, `complete` ------------------------------------------
  // A tree that would not come back leaves the task open, unless `user` asked
  // for it to be finished anyway.
  const complete = force || stuck.length === 0;
  if (complete && !wasComplete) record.setComplete(true);

  if (complete) {
    try {
      const parts = [`task marked done`];
      if (trees.length > 0) parts.push(`${trees.length - stuck.length} of ${trees.length} tree(s) returned`);
      if (force) {
        parts.push(
          killed.length > 0
            ? `--force: killed ${killed.map((k) => k.sid).join(' ')}, uncommitted changes discarded`
            : '--force: the orphan-commit guard was skipped',
        );
      }
      new Log(task).append(force && killed.length > 0 ? 'changed' : 'delivered', parts.join('; '));
    } catch { /* the task is done; a missing log line is not worth failing for */ }
  }

  if (stuck.length > 0) {
    throw new YanError('done_tree_held', `${stuck.length} tree(s) could not be returned, so ${complete ? `${task} is marked done but the pool slot(s) are stranded` : `${task} is NOT marked done`}:\n${stuck
        .map((t) => `    ${t.path}\n      ${t.reason ?? ''}`)
        .join('\n')}`,
      { exitCode: RC_TREE_HELD },
    );
  }

  return {
    version: 1,
    task,
    title: record.title(),
    complete,
    was_complete: wasComplete,
    forced: force,
    killed,
    trees,
  };
}

async function whichTasks(named: string): Promise<string[]> {
  if (named !== '') return [named];

  const fromEnv = process.env.YAN_TASK ?? '';
  if (fromEnv !== '') return [fromEnv];

  if (!isTty()) {
    throw YanError.usage('done_usage', "which task? pass it as the argument: 'yan done <task-id>'. Choosing interactively needs a terminal");
  }

  const open = openTasks();
  if (open.length === 0) return [];

  const { chooseTasksToFinish } = await import('../ui/prompts.js');
  return chooseTasksToFinish(open);
}

/** One task's outcome, as the summary and `--json` both carry it. */
type Outcome = { readonly ok: true; readonly result: DoneResult } | { readonly ok: false; readonly task: string; readonly exit_code: number; readonly error: string };

function render(o: Outcome): void {
  if (!o.ok) {
    out(`task     ${o.task} NOT finished (exit ${o.exit_code})`);
    for (const line of o.error.split('\n')) out(`  ${line}`);
    return;
  }
  const r = o.result;
  for (const k of r.killed) {
    out(`${k.sid}${k.unit === '' ? '' : `  ${k.unit}`}  killed: run/ removed${k.pane_closed ? ', pane closed' : ''}`);
  }
  for (const t of r.trees) {
    out(`tree     ${t.path} released${r.forced ? ' (uncommitted changes discarded)' : ''}`);
  }
  if (r.trees.length === 0) out('tree     (none were leased)');
  out(`task     ${r.task} ${r.was_complete ? 'was already done' : 'marked done'}  ${r.title}`);
}

export const command = new Command('done')
  .description('mark a task done and give its worktrees back')
  .argument('[task-id]', 'the task; defaults to $YAN_TASK, or asks when there is a terminal')
  .option('--force', "user has said the uncommitted changes can be thrown away")
  .option('--json', 'print the record instead of a summary')
  .addHelpText(
    'after',
    `
Sets complete in task.json and returns every tree the pool is holding for this
task. The two are one event: a finished task whose trees are still leased
shrinks the pool by a slot, and the pool refuses rather than grows.

With no id and a terminal, it asks - and it is a MULTI-select, because a round
that lands usually finishes more than one task. With no id and no terminal it
refuses and names the argument, so nothing ever hangs waiting for an answer
that is not coming. An explicit id always wins, then $YAN_TASK, then the
prompt.

Which trees belong to the task is asked of the pool, whose holder is
<task>/<unit>/<sid> - so a tree left behind by a teardown that stopped halfway
is found too.

Without --force this refuses rather than destroys:

  exit 4  a shift is still live. Nothing is touched at all.
  exit 5  a tree has uncommitted changes, or no remote branch contains its
          HEAD. Trees that did come back stay returned; the task is not
          marked done.

--force is user's answer, not a retry: live shifts are
killed and every tree is wiped past the orphan-commit guard. It destroys
uncommitted changes and untracked files. It does NOT destroy commits - those
stay on the shift branch in the clone, unpushed and reachable by name.

yan must not reach for --force on its own initiative.`,
  )
  .action(
    action('yan done', async (positional: string | undefined, options: DoneOptions) => {
      const tasks = await whichTasks(positional ?? '');

      // Nothing to offer is one line and exit 0, not a failure.
      if (tasks.length === 0) {
        if (options.json === true) out(JSON.stringify({ version: 1, tasks: [] }));
        else out('every task is already done');
        return;
      }

      // One task keeps the throwing path, so its exit code says which refusal
      // it hit.
      if (tasks.length === 1) {
        const r = finishTask({ force: options.force, task: tasks[0] as string });
        if (options.json === true) out(JSON.stringify({ version: 1, tasks: [r] }));
        else render({ ok: true, result: r });
        return;
      }

      // Several: every one is attempted, and every one is reported.
      const outcomes: Outcome[] = [];
      for (const task of tasks) {
        try {
          outcomes.push({ ok: true, result: finishTask({ force: options.force, task }) });
        } catch (err) {
          if (!isYanError(err)) throw err;
          outcomes.push({ ok: false, task, exit_code: err.exitCode, error: err.message });
        }
      }

      if (options.json === true) {
        out(JSON.stringify({ version: 1, tasks: outcomes.map((o) => (o.ok ? o.result : o)) }));
      } else {
        for (const [i, o] of outcomes.entries()) {
          if (i > 0) out('');
          render(o);
        }
      }

      const firstFailure = outcomes.find((o) => !o.ok);
      if (firstFailure !== undefined && !firstFailure.ok) {
        process.exitCode = firstFailure.exit_code;
      }
    }),
  );
