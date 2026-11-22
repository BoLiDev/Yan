import { isTty } from './tty.js';
import { Task, isClosed } from '../../records/task/index.js';
import type { TaskChoice } from '../../ui/prompts.js';
import { YanError } from '../../util/error.js';
import { everyVault, inVault, vaultDir } from '../../util/vault.js';

/**
 * Which task a command works on: the id it was given, then `$YAN_TASK`, which
 * `yan` sets for the agent it starts, then — at a terminal only — a select.
 * Without a terminal a missing id is a refusal naming the argument, so
 * nothing unattended hangs on an answer that is not coming.
 *
 * A machine with several vaults shows their tasks as one list, so a task is
 * looked for in each, in the list's order, and an id two vaults have is the
 * earlier one's. The command then works in the vault that has it: the
 * process is pointed there, as an agent's session is, so every record it
 * goes on to read or write is that vault's.
 */

/** The task ids every vault has, each once, with the vault that answers for it: the first in the list to have it. */
export function tasksEverywhere(): { id: string; vault: string; dir: string }[] {
  // The active vault has to be one this build reads: its refusal, missing, too old or too new, is said here as any command says it.
  vaultDir();
  const seen = new Set<string>();
  const found: { id: string; vault: string; dir: string }[] = [];
  for (const { name, dir } of everyVault()) {
    for (const id of inVault(dir, () => Task.list())) {
      if (seen.has(id)) continue;
      seen.add(id);
      found.push({ id, vault: name, dir });
    }
  }
  return found;
}

/** Point this process at `dir` from here on: what a command does once it knows which vault its task is in. */
export function workIn(dir: string): void {
  process.env.YAN_VAULT = dir;
}

/**
 * The vault that answers for task `id`: the first in the list to have it,
 * or undefined. An invalid id is no vault's.
 */
function vaultOf(id: string): string | undefined {
  if (!Task.isId(id)) return undefined;
  return everyVault().find(({ dir }) => inVault(dir, () => Task.exists(id)))?.dir;
}

/**
 * The task `id` names, which has to exist.
 *
 * @throws YanError `task_missing` (exit 2) when there is no such task.
 */
export function existingTask(id: string): Task {
  const dir = vaultOf(id);
  if (dir !== undefined) workIn(dir);
  const task = new Task(id);
  if (!task.exists()) {
    throw YanError.usage('task_missing', `no such task: ${id} - 'yan ls --status all' lists them`);
  }
  return task;
}

/** Every task that is neither closed nor paused, as a select offers them: one an agent may be started on. */
export function openTasks(): TaskChoice[] {
  const open: TaskChoice[] = [];
  const several = everyVault().length > 1;
  for (const { id, vault, dir } of tasksEverywhere()) {
    try {
      const data = inVault(dir, () => new Task(id).read());
      if (!isClosed(data.state) && data.pausedAt === undefined) open.push({ id, title: data.title, ...(several ? { vault } : {}) });
    } catch {
      // A task.json yan cannot read is not offered; 'yan peek <id>' says why.
    }
  }
  return open;
}

/** The argument, then `$YAN_TASK`; `undefined` when neither says. */
export function givenTask(given: string | undefined): string | undefined {
  if (given !== undefined && given !== '') return given;
  const fromEnv = process.env.YAN_TASK ?? '';
  return fromEnv === '' ? undefined : fromEnv;
}

/**
 * `givenTask`, refusing when neither says. For the commands an agent runs,
 * which never prompt.
 *
 * @param flag how the id is passed to this command, `--task <id>`.
 * @throws YanError `task_usage` when no task is named.
 */
export function requiredTask(given: string | undefined, flag: string): Task {
  const id = givenTask(given);
  if (id === undefined) {
    throw YanError.usage('task_usage', `which task? pass ${flag} - $YAN_TASK is unset, and 'yan ls' lists the tasks`);
  }
  return existingTask(id);
}

/**
 * `givenTask`, then a select among the open tasks.
 *
 * @param spelled the command as a person types it, `yan peek`.
 * @throws YanError `task_usage` when there is nothing to choose from, or no
 *   terminal to ask in.
 */
export async function chosenTask(given: string | undefined, spelled: string, question: string): Promise<Task> {
  const id = givenTask(given);
  if (id !== undefined) return existingTask(id);
  if (!isTty()) {
    throw YanError.usage('task_usage', `which task? pass it: '${spelled} <task-id>' - 'yan ls' lists them`);
  }
  const open = openTasks();
  if (open.length === 0) {
    throw YanError.usage('task_usage', "there are no open tasks - 'yan ls --status all' lists the closed ones");
  }
  const { chooseTask } = await import('../../ui/prompts.js');
  return existingTask(await chooseTask(open, spelled, question));
}
