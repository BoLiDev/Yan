import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { readNote, appendLog } from './shared/note.js';
import { repoDirIfKnown } from './shared/repo.js';
import { isTty } from './shared/tty.js';
import { chosenTask, existingTask } from './shared/task-id.js';
import { leasesHeldBy, returnLease } from './shared/teardown.js';
import { closeIfOpen, describeShift, requireConsent, tearDown, type AbandonDeps, type AbandonedShift, type MrClosing } from './shared/abandon.js';
import { Shift } from '../records/shift/index.js';
import { Task } from '../records/task/index.js';
import { isYanError, YanError } from '../util/error.js';

/**
 * Giving work up: `yan shift abandon <sid>` for one shift, `yan abandon <id>`
 * for a whole task. Both destroy work that exists nowhere else and close merge
 * requests colleagues can see, so both need `--user-asked`, and both need a
 * reason, which is what the log keeps. This is the task's; the shift's is
 * `shift/abandon.ts`, and the teardown both run is `shared/abandon.ts`.
 *
 * What goes: the agent and its pane, `run/`, the tree with anything
 * uncommitted in it, and any merge request still open. What stays: the brief,
 * outcome.md, and every pushed branch — an unmerged branch is never deleted,
 * and abandoned work may still be wanted.
 */

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
 * The task record, once it is known to be one that can still be given up.
 *
 * @throws YanError `abandon_usage` for a task that is missing, already
 *   abandoned, or already done.
 */
function abandonable(task: string): { record: Task; data: ReturnType<Task['read']> } {
  const record = existingTask('abandon', task);
  const data = record.read();
  if (data.abandoned) throw YanError.usage('abandon_usage', `${task} is already abandoned`);
  if (data.complete) throw YanError.usage('abandon_usage', `${task} is done - there is nothing left to give up`);
  return { record, data };
}

/**
 * `yan abandon <id>` without the process around it: every live shift torn
 * down, every open outbound merge request closed, every tree returned, and the
 * task marked abandoned.
 *
 * @throws YanError `abandon_usage` without `--user-asked` or `--reason`, or for a
 *   task that is missing, already abandoned, or already done.
 */
export function abandonTask(options: TaskAbandonOptions, deps: AbandonDeps = {}): AbandonedTask {
  const task = options.task ?? '';
  if (task === '') throw YanError.usage('abandon_usage', 'which task? pass its id, or set $YAN_TASK');
  const reason = requireConsent('abandon', options.userAsked, options.reason);
  return giveUp(task, `— ${reason}`, deps);
}

/**
 * The work itself, for a caller that already has user's word. `why` ends the
 * log line and reads as its last clause.
 */
function giveUp(task: string, why: string, deps: AbandonDeps): AbandonedTask {
  const { record, data } = abandonable(task);

  const shifts = Shift.liveIn(task).map((s) => tearDown(s, deps));

  const outbound = data.units
    .filter((u) => u.mr !== null && u.mr !== '')
    .map((u) => {
      const clone = repoDirIfKnown(u.repo);
      return { unit: u.name, mr: u.mr as string, mr_closing: closeIfOpen(u.mr as string, clone, deps) };
    });

  const trees: AbandonedTask['trees'][number][] = [];
  for (const lease of leasesHeldBy(task, deps.pool)) {
    const back = returnLease(
      lease.clone,
      lease.path,
      { leaseId: lease.lease_id, holder: lease.holder, force: true },
      deps.pool,
    );
    trees.push({ holder: lease.holder, path: lease.path, returned: back.returned });
  }

  record.setAbandoned();
  const closed = [...shifts, ...outbound].filter((r) => r.mr_closing === 'closed').length;
  const killed = shifts.length > 0 ? `; ${shifts.map((s) => s.sid).join(' ')} torn down` : '';
  appendLog('yan abandon', task, 'changed', `task abandoned${killed}${closed > 0 ? `; ${closed} merge request(s) closed` : ''} ${why}`);

  return { version: 1, task, shifts, outbound, trees };
}

/**
 * What a person at a terminal is asked, one question each. Every one throws
 * YanError `ui_cancelled` when they press escape.
 */
export interface AbandonAsk {
  /** Which task, when the argument and `$YAN_TASK` did not say. */
  readonly task: () => Promise<string>;
  /** Why, in one line; the empty string when they would rather not say. */
  readonly reason: () => Promise<string>;
  /** Whether to go ahead with what `plan` describes. */
  readonly confirm: (title: string, plan: readonly string[]) => Promise<boolean>;
}

/**
 * What giving `task` up would do, as lines a person reads before saying yes.
 * Asks nothing of the forge: an outbound request is closed only if it is still
 * open, which is the forge's answer at the time.
 */
function abandonPlan(task: string, deps: AbandonDeps = {}): string[] {
  const { data } = abandonable(task);
  const lines: string[] = [];
  for (const s of Shift.liveIn(task)) {
    const meta = s.meta();
    const mr = s.openedMr(meta);
    lines.push(`${s.sid} ${meta.unit ?? ''}  abandoned: its agent killed, its tree discarded with anything uncommitted${mr === '' ? '' : `, ${mr} closed if still open`}`);
  }
  for (const u of data.units) {
    if (u.mr !== null && u.mr !== '') lines.push(`${u.name}  outbound ${u.mr} closed if still open`);
  }
  let held: ReturnType<typeof leasesHeldBy> = [];
  try {
    held = leasesHeldBy(task, deps.pool);
  } catch { /* the pool could not say; the trees still go back */ }
  for (const lease of held) lines.push(`tree   ${lease.path} returned`);
  if (lines.length === 0) lines.push('nothing is running, open or leased');
  lines.push('every pushed branch stays, and the brief, outcome.md and log.md with it');
  return lines;
}

/**
 * `yan abandon` typed by a person at a terminal, without the process around
 * it. Typing it is user asking, so `--user-asked` is implied here and nowhere
 * else; what the flags leave out is asked for, and `--user-asked` skips the
 * confirmation. The reason may be left empty.
 *
 * @returns what was given up, or `undefined` when they said no.
 * @throws YanError `ui_cancelled` when they cancelled a prompt, before anything
 *   was touched; `abandon_usage` as `abandonTask` does.
 */
export async function abandonAtTerminal(
  given: string | undefined,
  options: TaskAbandonOptions,
  ask: AbandonAsk,
  deps: AbandonDeps = {},
): Promise<AbandonedTask | undefined> {
  const task = given !== undefined && given !== '' ? given : await ask.task();
  const { data } = abandonable(task);

  const reason = options.reason !== undefined ? readNote('abandon', options.reason) : (await ask.reason()).trim();
  if (/[\r\n]/.test(reason)) throw YanError.usage('abandon_usage', 'the reason is one line - it becomes part of a single log.md entry');

  if (options.userAsked !== true) {
    const title = `${task}${data.title === '' ? '' : `  ${data.title}`}`;
    if (!(await ask.confirm(title, abandonPlan(task, deps)))) return undefined;
  }
  return giveUp(task, reason === '' ? '— user gave no reason' : `— ${reason}`, deps);
}

/** Can a person answer here? Both ends of the terminal, since the plan is shown before the question. */
function atTerminal(): boolean {
  return isTty() && process.stdout.isTTY === true;
}

export const command = new Command('abandon')
  .description('give a whole task up - only when user asks')
  .argument('[task-id]', 'defaults to $YAN_TASK, or asks when there is a terminal')
  .option('--reason <text>', 'one line saying why, for log.md; required without a terminal')
  .option('--user-asked', 'user said this task is to be given up; required without a terminal')
  .option('--json', 'print the record instead of a summary')
  .addHelpText(
    'after',
    `
Abandons every live shift as 'yan shift abandon' does, closes every outbound
merge request still open, returns every tree the task holds - the standing
trees included - and marks the task abandoned, which 'yan ls' and 'yan show'
say. Branches stay. Exit 1 when something is left to do by hand.

Two ways to run it:

  At a terminal, typed by user: 'yan abandon' asks which task when there is
  no argument, asks why (an empty answer is fine), shows what will happen
  and asks for a yes, defaulting to no. Typing it is user asking, so
  --user-asked is implied; a flag that is given skips its question, and
  --user-asked skips the yes. Cancelling any question touches nothing.

  Without a terminal, as the agent runs it: both flags are required -
      yan abandon <task-id> --user-asked --reason "<why>"
  and only after user has said so.`,
  )
  .action(
    action('yan abandon', async (id: string | undefined, options: TaskAbandonOptions) => {
      let r: AbandonedTask;
      if (atTerminal() && (options.userAsked !== true || options.reason === undefined)) {
        const prompts = await import('../ui/prompts.js');
        let done: AbandonedTask | undefined;
        try {
          done = await abandonAtTerminal(id ?? (process.env.YAN_TASK || undefined), options, {
            task: () => chosenTask('abandon', undefined, { spelled: 'yan abandon', question: 'Which task is being given up?' }),
            reason: () => prompts.askAbandonReason(),
            confirm: (title, plan) => prompts.confirmAbandon(title, plan),
          });
        } catch (err) {
          if (!(isYanError(err) && err.code === 'ui_cancelled')) throw err;
          done = undefined;
        }
        if (done === undefined) {
          out('nothing was abandoned - cancelled');
          return;
        }
        r = done;
      } else {
        const task = await chosenTask('abandon', id, {
          spelled: 'yan abandon',
          question: 'Which task is being given up?',
        });
        r = abandonTask({ ...options, task });
      }
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
