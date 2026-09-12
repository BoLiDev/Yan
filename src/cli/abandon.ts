import { rmSync } from 'node:fs';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { display } from './shared/display.js';
import { readNote } from './shared/note.js';
import { repoDirIfKnown } from './shared/repo.js';
import { chosenTask } from './shared/task-id.js';
import { heldBy } from './done.js';
import { Terminal } from '../externals/herdr/index.js';
import { RemoteGit, type MrState } from '../externals/remote-git/index.js';
import { WorktreePool } from '../externals/worktree/index.js';
import { Log } from '../records/log/index.js';
import { opensMr, Shift } from '../records/shift/index.js';
import { Task } from '../records/task/index.js';
import { YanError } from '../util/error.js';

/**
 * Giving work up: `yan shift abandon <sid>` for one shift, `yan abandon <id>`
 * for a whole task. Both destroy work that exists nowhere else and close merge
 * requests colleagues can see, so both need `--user-asked`, and both need a
 * reason, which is what the log keeps.
 *
 * What goes: the agent and its pane, `run/`, the tree with anything
 * uncommitted in it, and any merge request still open. What stays: the brief,
 * outcome.md, and every pushed branch — an unmerged branch is never deleted,
 * and abandoned work may still be wanted.
 */

/** What abandoning needs from the outside. Each defaults to the real one. */
export interface AbandonDeps {
  readonly terminal?: {
    close(pane: string): void;
    clearPaneTitle(pane: string): void;
    agentAlive?(pane: string): 'alive' | 'dead' | 'unknown';
  };
  readonly pool?: (clone: string) => Pick<WorktreePool, 'return' | 'status'>;
  readonly mrStateOf?: (mr: string, dir: string | undefined) => MrState;
  readonly closeMr?: (mr: string, dir: string | undefined) => void;
}

/** What became of a merge request that was asked to close. */
type MrClosing = 'closed' | 'already-closed' | 'merged' | 'unknown' | 'failed' | 'none';

interface AbandonedShift {
  readonly sid: string;
  readonly unit: string;
  readonly mr: string;
  readonly mr_closing: MrClosing;
  readonly tree_returned: boolean;
  readonly pane_closed: boolean;
  readonly pane: string;
}

function requireConsent(command: string, userAsked: boolean | undefined, reason: string | undefined): string {
  if (userAsked !== true) {
    throw YanError.usage(`${command}_usage`, "abandoning destroys work that exists nowhere else and closes merge requests colleagues can see, so only user asks for it. Nothing was touched. When they have, re-run with --user-asked");
  }
  const text = readNote(command, reason);
  if (text === '') {
    throw YanError.usage(`${command}_usage`, '--reason is required - one line saying why this is being given up, which is what the log keeps');
  }
  return text;
}

/**
 * Close a merge request that is still open, and answer what became of it.
 * Never throws: a forge that cannot be reached must not keep the local work
 * alive, so the failure is reported instead.
 */
function closeIfOpen(mr: string, dir: string | undefined, deps: AbandonDeps): MrClosing {
  if (mr === '') return 'none';
  let state: MrState;
  try {
    state = (deps.mrStateOf ?? ((url: string, d: string | undefined) => new RemoteGit().mrState({ mr: url, dir: d })))(mr, dir);
  } catch {
    return 'unknown';
  }
  if (state === 'merged') return 'merged';
  if (state === 'closed') return 'already-closed';
  if (state === 'unknown') return 'unknown';
  try {
    (deps.closeMr ?? ((url: string, d: string | undefined) => new RemoteGit().closeMr({ mr: url, dir: d })))(mr, dir);
    return 'closed';
  } catch {
    return 'failed';
  }
}

/** Close a pane, and answer whether its agent really went. */
function closePane(pane: string, deps: AbandonDeps): boolean {
  if (pane === '') return true;
  const terminal = deps.terminal ?? new Terminal();
  display('could not clear the shift pane title', () => {
    terminal.clearPaneTitle(pane);
  });
  display('could not close the shift pane', () => {
    terminal.close(pane);
  });
  if (terminal.agentAlive === undefined) return true;
  try {
    return terminal.agentAlive(pane) !== 'alive';
  } catch {
    return true;
  }
}

/**
 * Tear one live shift down without accepting its work. The caller has the
 * consent and the reason; this does the work and never throws for the forge,
 * the terminal or the pool, reporting each instead.
 */
function tearDown(shift: Shift, deps: AbandonDeps): AbandonedShift {
  const meta = shift.meta();
  const unit = meta.unit ?? '';
  const tree = meta.tree ?? '';
  const pane = meta.pane ?? '';
  let clone = meta.clone ?? '';
  if (clone === '' && shift.task !== '' && unit !== '' && Task.exists(shift.task)) {
    const repo = new Task(shift.task).findUnit(unit)?.read().repo ?? '';
    clone = repo === '' ? '' : (repoDirIfKnown(repo) ?? '');
  }

  // Only coding opens merge requests.
  const mr = opensMr(meta.scenario) ? (meta.mr ?? shift.reportedMr() ?? '') : '';
  const mrClosing = closeIfOpen(mr, clone === '' ? undefined : clone, deps);

  // The agent first, so nothing is still writing into the tree being wiped.
  const paneClosed = closePane(pane, deps);
  rmSync(shift.run, { recursive: true, force: true });

  let returned = false;
  if (tree !== '' && clone !== '') {
    try {
      (deps.pool?.(clone) ?? new WorktreePool(clone)).return(tree, {
        ...(meta.lease_id === undefined ? {} : { leaseId: meta.lease_id }),
        ...(meta.holder === undefined ? {} : { holder: meta.holder }),
        force: true,
      });
      returned = true;
    } catch (err) {
      process.stderr.write(`yan abandon: the tree at ${tree} could not be returned - 'yan tree status' shows the lease (${err instanceof Error ? err.message : String(err)})\n`);
    }
  }

  return { sid: shift.sid, unit, mr, mr_closing: mrClosing, tree_returned: returned, pane_closed: paneClosed, pane };
}

function mrPhrase(r: { mr: string; mr_closing: MrClosing }): string {
  switch (r.mr_closing) {
    case 'closed':
      return `; ${r.mr} closed`;
    case 'failed':
      return `; ${r.mr} could NOT be closed`;
    case 'unknown':
      return `; the host could not say what became of ${r.mr}, so it was left`;
    case 'merged':
      return `; ${r.mr} had already merged`;
    default:
      return '';
  }
}

interface ShiftAbandonOptions {
  task?: string;
  reason?: string;
  userAsked?: boolean;
  json?: boolean;
}

/**
 * `yan shift abandon <sid>` without the process around it.
 *
 * @throws YanError `usage` without `--user-asked` or `--reason`, for a
 *   missing sid, or for a shift that has already clocked out.
 */
export function abandonShift(sid: string | undefined, options: ShiftAbandonOptions, deps: AbandonDeps = {}): AbandonedShift {
  if (sid === undefined || sid === '') throw YanError.usage('shift_abandon_usage', 'a shift id is required');
  const reason = requireConsent('shift_abandon', options.userAsked, options.reason);
  const shift = Shift.resolve(sid, options.task ?? '');
  if (!shift.isLive()) {
    throw YanError.usage('shift_abandon_usage', `shift ${shift.label()} is not live - run/ is gone, so there is nothing to abandon`);
  }

  const result = tearDown(shift, deps);
  if (shift.task !== '') {
    try {
      new Log(shift.task).append('changed', `${result.sid} ${result.unit}  abandoned${mrPhrase(result)} — ${reason}`);
    } catch { /* the teardown is done; its log line is not worth failing for */ }
  }
  return result;
}

interface TaskAbandonOptions {
  task?: string;
  reason?: string;
  userAsked?: boolean;
  json?: boolean;
}

interface AbandonedTask {
  readonly version: 1;
  readonly task: string;
  readonly shifts: readonly AbandonedShift[];
  readonly outbound: readonly { readonly unit: string; readonly mr: string; readonly mr_closing: MrClosing }[];
  readonly trees: readonly { readonly holder: string; readonly path: string; readonly returned: boolean }[];
}

/**
 * `yan abandon <id>` without the process around it: every live shift torn
 * down, every open outbound merge request closed, every tree returned, and the
 * task marked abandoned.
 *
 * @throws YanError `usage` without `--user-asked` or `--reason`, or for a
 *   task that is missing, already abandoned, or already done.
 */
export function abandonTask(options: TaskAbandonOptions, deps: AbandonDeps = {}): AbandonedTask {
  const task = options.task ?? '';
  if (task === '') throw YanError.usage('abandon_usage', 'which task? pass its id, or set $YAN_TASK');
  const reason = requireConsent('abandon', options.userAsked, options.reason);
  if (!Task.exists(task)) throw YanError.usage('abandon_usage', `no such task: ${task}`);
  const record = new Task(task);
  const data = record.read();
  if (data.abandoned) throw YanError.usage('abandon_usage', `${task} is already abandoned`);
  if (data.complete) throw YanError.usage('abandon_usage', `${task} is done - there is nothing left to give up`);

  const shifts = Shift.liveIn(task).map((s) => tearDown(s, deps));

  const outbound = data.units
    .filter((u) => u.mr !== null && u.mr !== '')
    .map((u) => {
      const clone = repoDirIfKnown(u.repo);
      return { unit: u.name, mr: u.mr as string, mr_closing: closeIfOpen(u.mr as string, clone, deps) };
    });

  const trees: AbandonedTask['trees'][number][] = [];
  for (const lease of heldBy(task, { ...(deps.pool === undefined ? {} : { pool: deps.pool }) })) {
    try {
      (deps.pool?.(lease.clone) ?? new WorktreePool(lease.clone)).return(lease.path, {
        leaseId: lease.lease_id,
        holder: lease.holder,
        force: true,
      });
      trees.push({ holder: lease.holder, path: lease.path, returned: true });
    } catch {
      trees.push({ holder: lease.holder, path: lease.path, returned: false });
    }
  }

  record.setAbandoned();
  try {
    const closed = [...shifts, ...outbound].filter((r) => r.mr_closing === 'closed').length;
    const killed = shifts.length > 0 ? `; ${shifts.map((s) => s.sid).join(' ')} torn down` : '';
    new Log(task).append('changed', `task abandoned${killed}${closed > 0 ? `; ${closed} merge request(s) closed` : ''} — ${reason}`);
  } catch { /* the task is abandoned either way */ }

  return { version: 1, task, shifts, outbound, trees };
}

/** Lines a person reads about a torn-down shift, and whether anything is left to do by hand. */
function describeShift(r: AbandonedShift): { lines: string[]; leftover: boolean } {
  const lines = [`${r.sid} abandoned`];
  if (r.mr !== '') lines.push(`  mr     ${r.mr} (${r.mr_closing})`);
  lines.push(`  tree   ${r.tree_returned ? 'returned' : 'NOT returned'}`);
  let leftover = !r.tree_returned || r.mr_closing === 'failed';
  if (!r.pane_closed) {
    lines.push(`  pane   ${r.pane} is still running an agent - close it by hand`);
    leftover = true;
  }
  return { lines, leftover };
}

export const shiftAbandonCommand = new Command('abandon')
  .description("give a shift up: close its merge request, kill its agent, discard its tree - only when user asks")
  .argument('[sid]')
  .option('--reason <text>', 'REQUIRED: one line saying why, for log.md')
  .option('--user-asked', 'REQUIRED: user said this work is to be given up')
  .option('--json', 'print the record instead of a summary')
  .addHelpText(
    'after',
    `
Closes the shift's merge request if it is still open, closes its pane and
checks the agent went, deletes run/, and returns its tree with anything
uncommitted in it. The brief, outcome.md and any pushed branch stay. Exit 1
when something is left to do by hand.`,
  )
  .action(
    action('yan shift abandon', (sid: string | undefined, options: ShiftAbandonOptions) => {
      const r = abandonShift(sid, options);
      if (options.json === true) out(JSON.stringify(r));
      const { lines, leftover } = describeShift(r);
      if (options.json !== true) for (const line of lines) out(line);
      if (leftover) process.exitCode = 1;
    }),
  );

export const command = new Command('abandon')
  .description('give a whole task up - only when user asks')
  .argument('[task-id]', 'defaults to $YAN_TASK, or asks when there is a terminal')
  .option('--reason <text>', 'REQUIRED: one line saying why, for log.md')
  .option('--user-asked', 'REQUIRED: user said this task is to be given up')
  .option('--json', 'print the record instead of a summary')
  .addHelpText(
    'after',
    `
Abandons every live shift as 'yan shift abandon' does, closes every outbound
merge request still open, returns every tree the task holds - the standing
trees included - and marks the task abandoned, which 'yan ls' and 'yan show'
say. Branches stay. Exit 1 when something is left to do by hand.`,
  )
  .action(
    action('yan abandon', async (id: string | undefined, options: TaskAbandonOptions) => {
      const task = await chosenTask('abandon', id, {
        spelled: 'yan abandon',
        question: 'Which task is being given up?',
      });
      const r = abandonTask({ ...options, task });
      let leftover = false;
      if (options.json === true) {
        out(JSON.stringify(r));
      } else {
        out(`${r.task} abandoned`);
      }
      for (const s of r.shifts) {
        const d = describeShift(s);
        if (options.json !== true) for (const line of d.lines) out(`  ${line}`);
        leftover ||= d.leftover;
      }
      for (const o of r.outbound) {
        if (options.json !== true) out(`  ${o.unit}  outbound ${o.mr} (${o.mr_closing})`);
        leftover ||= o.mr_closing === 'failed';
      }
      for (const t of r.trees) {
        if (options.json !== true) out(`  tree   ${t.path} ${t.returned ? 'returned' : 'NOT returned'}`);
        leftover ||= !t.returned;
      }
      if (leftover) process.exitCode = 1;
    }),
  );
