import { isTty } from './tty.js';
import { Task } from '../../records/task/index.js';
import type { TaskChoice } from '../../ui/prompts.js';
import { YanError } from '../../util/error.js';

/**
 * Which task a command works on: the id it was given, then `$YAN_TASK`, which
 * `yan` sets for the agent it starts, then — at a terminal only — a select.
 * Without a terminal a missing id is a refusal naming the argument, so
 * nothing unattended hangs on an answer that is not coming.
 */

/**
 * The task `id` names, which has to exist.
 *
 * @throws YanError `task_missing` (exit 2) when there is no such task.
 */
export function existingTask(id: string): Task {
  const task = new Task(id);
  if (!task.exists()) {
    throw YanError.usage('task_missing', `no such task: ${id} - 'yan ls --status all' lists them`);
  }
  return task;
}

/** Every task that is not closed, as a select offers them. */
export function openTasks(): TaskChoice[] {
  const open: TaskChoice[] = [];
  for (const id of Task.list()) {
    try {
      const data = new Task(id).read();
      if (data.state === 'open') open.push({ id, title: data.title });
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
