import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { display } from './shared/display.js';
import { CommandError } from './shared/errors.js';
import { repoDir } from './shared/repo.js';
import { isTty } from './shared/resolve.js';
import { queueJson } from './ls.js';
import { isYanError } from '../util/error.js';
import { Terminal } from '../externals/herdr/index.js';
import { WorktreePool, type LeaseRow } from '../externals/worktree/index.js';
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
 * Which task: an explicit id or `--task`, then `$YAN_TASK`, then a
 * multi-select when there is a tty, then a refusal. Several tasks are all
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

/** What `yan done` needs from the terminal. `Terminal` is the real one. */
export interface Closer {
  close(pane: string): void;
  clearPaneTitle(pane: string): void;
}

export interface DoneDeps {
  readonly terminal?: Closer;
  readonly pool?: (clone: string) => Pick<WorktreePool, 'return' | 'status'>;
}

export interface KilledShift {
  readonly sid: string;
  readonly unit: string;
  readonly pane_closed: boolean;
}

export interface ReturnedTree {
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

/** A lease of this task, with the clone it belongs to. */
interface Held extends LeaseRow {
  readonly clone: string;
}

/**
 * Every tree the pool is holding for this task, sorted by holder. Looks in
 * every repository the units name and every one a live shift records, since a
 * re-pointed unit can leave a lease task.json no longer mentions. A repository
 * that cannot be resolved is skipped rather than fatal.
 */
function heldBy(task: string, deps: DoneDeps): Held[] {
  const repos = new Set<string>();
  for (const unit of new Task(task).read().units) {
    if (typeof unit.repo === 'string' && unit.repo !== '') repos.add(unit.repo);
  }
  for (const shift of Shift.liveIn(task)) {
    const clone = shift.meta().clone ?? '';
    if (clone !== '' && existsSync(clone)) repos.add(clone);
  }

  const seen = new Set<string>();
  const held: Held[] = [];
  for (const repo of repos) {
    let clone: string;
    try {
      clone = repoDir('done', repo);
    } catch {
      continue;
    }
    if (seen.has(clone)) continue;
    seen.add(clone);

    let leases: LeaseRow[];
    try {
      leases = (deps.pool?.(clone) ?? new WorktreePool(clone)).status();
    } catch {
      continue;
    }
    for (const lease of leases) {
      if (lease.holder.startsWith(`${task}/`)) held.push({ ...lease, clone });
    }
  }
  return held.sort((a, b) => (a.holder < b.holder ? -1 : a.holder > b.holder ? 1 : 0));
}

/**
 * Close a live shift's pane and delete its `run/`, leaving outcome.md, the
 * status log and the brief. Never throws for a pane it cannot close.
 */
function kill(shift: Shift, terminal: Closer): KilledShift {
  const meta = shift.meta();
  const pane = meta.agentId ?? '';
  let closed = false;
  if (pane !== '') {
    display('could not clear the shift pane title', () => { terminal.clearPaneTitle(pane); });
    display('could not close the shift pane', () => { terminal.close(pane); closed = true; });
  }
  rmSync(shift.run, { recursive: true, force: true });
  return { sid: shift.sid, unit: meta.unit ?? '', pane_closed: closed };
}

/**
 * Finish one task: return its trees and mark it complete.
 *
 * @throws CommandError `usage` when no task is named, `missing` for an unknown
 *   one, `live_shifts` (exit 4) when a shift is still live and `--force` was
 *   not given — nothing is touched in that case — and `tree_held` (exit 5)
 *   when a tree would not come back, after the others have been returned.
 */
export function finishTask(options: DoneOptions, deps: DoneDeps = {}): DoneResult {
  const task = options.task ?? process.env.YAN_TASK ?? '';
  if (task === '') {
    throw CommandError.usage('done', 'which task? pass it as the argument, or set $YAN_TASK');
  }
  if (!Task.exists(task)) {
    const where = Task.isId(task) ? new Task(task).file : `${task}/task.json`;
    throw new CommandError('done', 'missing', `no such task: ${task} - ${where} does not exist`);
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
    throw new CommandError('done', 'live_shifts', `${task} still has live shifts: ${named}\n    they are holding trees and may be mid-edit. Clock them out with 'yan shift done <sid>' once their merge requests have merged, or - if user says the work can be thrown away - re-run with --force`,
      { exitCode: RC_LIVE_SHIFTS },
    );
  }

  // --- 2. with --force, kill them, and read the pool after -------------------
  const terminal = deps.terminal ?? new Terminal();
  const killed = force ? live.map((s) => kill(s, terminal)) : [];

  // --- 3. the trees ----------------------------------------------------------
  const trees: ReturnedTree[] = [];
  for (const lease of heldBy(task, deps)) {
    const pool = deps.pool?.(lease.clone) ?? new WorktreePool(lease.clone);
    try {
      const path = pool.return(lease.path, {
        leaseId: lease.lease_id,
        holder: lease.holder,
        force,
      });
      trees.push({ holder: lease.holder, path: path === '' ? lease.path : path, returned: true });
    } catch (err) {
      trees.push({
        holder: lease.holder,
        path: lease.path,
        returned: false,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
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
      new Log(task).append(parts.join('; '));
    } catch { /* the task is done; a missing log line is not worth failing for */ }
  }

  if (stuck.length > 0) {
    throw new CommandError('done', 'tree_held', `${stuck.length} tree(s) could not be returned, so ${complete ? `${task} is marked done but the pool slot(s) are stranded` : `${task} is NOT marked done`}:\n${stuck
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

export interface Finishable {
  readonly id: string;
  readonly title: string;
  readonly units: number;
  readonly shifts: number;
}

/** The rows the multi-select offers: every task in the queue not yet complete. */
export function finishableTasks(): Finishable[] {
  const queue = queueJson() as {
    tasks: { id: string; title: string; complete: boolean; units: unknown[]; shifts: number }[];
  };
  return queue.tasks
    .filter((t) => !t.complete)
    .map((t) => ({ id: t.id, title: t.title, units: t.units.length, shifts: t.shifts }));
}

async function whichTasks(named: string): Promise<string[]> {
  if (named !== '') return [named];

  const fromEnv = process.env.YAN_TASK ?? '';
  if (fromEnv !== '') return [fromEnv];

  if (!isTty()) {
    throw CommandError.usage('done', 'which task? pass it as the argument, or set $YAN_TASK');
  }

  const open = finishableTasks();
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
  .option('--task <id>', 'the task, as a flag instead of the argument')
  .option('--force', "user has said the uncommitted changes can be thrown away")
  .option('--json', 'print the record instead of a summary')
  .addHelpText(
    'after',
    `
usage: yan done [<task-id>] [--task <id>] [--force] [--json]

Sets complete in task.json and returns every tree the pool is holding for this
task. The two are one event: a finished task whose trees are still leased
shrinks the pool by a slot, and the pool refuses rather than grows.

With no id and a terminal, it asks - and it is a MULTI-select, because a round
that lands usually finishes more than one task. With no id and no terminal it
refuses and names the flag, so nothing ever hangs waiting for an answer that is
not coming. An explicit id always wins, then $YAN_TASK, then the prompt.

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
      if (positional !== undefined && options.task !== undefined && positional !== options.task) {
        throw CommandError.usage('done', `two different tasks named: '${positional}' and '--task ${options.task}' - pass one`);
      }
      const tasks = await whichTasks(options.task ?? positional ?? '');

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
