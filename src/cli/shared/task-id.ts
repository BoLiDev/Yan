import { isTty } from './resolve.js';
import { queueJson } from '../ls.js';
import type { TaskChoice } from '../../ui/prompts.js';
import { YanError } from '../../util/error.js';

/**
 * Which task a command works on. There is no `--task` anywhere: a task id
 * reached by two spellings is a task id two callers can disagree about.
 *
 * Two shapes, because there are two kinds of caller. `insideTask` is for the
 * commands yan runs while it is working on one — the environment already says
 * which, and anything else would be yan naming a task it is not in.
 * `chosenTask` is for the commands a person runs from anywhere.
 */

/**
 * The task this process is inside, from `$YAN_TASK`.
 *
 * @throws YanError `usage` when it is unset, which means the caller is not
 *   inside a task at all.
 */
export function insideTask(command: string): string {
  const task = process.env.YAN_TASK ?? '';
  if (task === '') {
    throw YanError.usage(`${command}_usage`, "which task? this command runs inside one, and $YAN_TASK is unset - 'yan continue <id>' sets it, and 'yan ls' lists the tasks");
  }
  return task;
}

/**
 * Every task in the queue that is not finished, in the shape every select
 * offers: bare `yan`, `yan done`, `yan continue` and `yan show` all ask this.
 */
export function openTasks(): TaskChoice[] {
  return queueJson()
    .tasks.filter((t) => !t.complete)
    .map((t) => ({ id: t.id, title: t.title, units: t.units.length, shifts: t.shifts }));
}

/**
 * The argument, then `$YAN_TASK`, then a select among the tasks in progress —
 * and, with no terminal to ask in, a refusal naming the argument, so nothing
 * unattended hangs on an answer that is not coming.
 *
 * @throws YanError `usage` when there is nothing to choose from, or no way
 *   to ask.
 */
export async function chosenTask(
  command: string,
  given: string | undefined,
  ask: { readonly spelled: string; readonly question: string },
): Promise<string> {
  if (given !== undefined && given !== '') return given;

  const fromEnv = process.env.YAN_TASK ?? '';
  if (fromEnv !== '') return fromEnv;

  if (!isTty()) {
    throw YanError.usage(`${command}_usage`, `which task? pass it as the argument: '${ask.spelled} <task-id>'. Choosing interactively needs a terminal, and 'yan ls' lists the tasks`);
  }

  const open = openTasks();
  if (open.length === 0) {
    throw YanError.usage(`${command}_usage`, "there are no tasks in progress - 'yan ls' lists the finished ones");
  }

  const { chooseTask } = await import('../../ui/prompts.js');
  return chooseTask(open, ask.spelled, ask.question);
}
