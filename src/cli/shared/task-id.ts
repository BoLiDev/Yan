import { CommandError } from './errors.js';
import { isTty } from './resolve.js';
import { queueJson } from '../ls.js';

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
 * @throws CommandError `usage` when it is unset, which means the caller is not
 *   inside a task at all.
 */
export function insideTask(command: string): string {
  const task = process.env.YAN_TASK ?? '';
  if (task === '') {
    throw CommandError.usage(command, "which task? this command runs inside one, and $YAN_TASK is unset - 'yan continue <id>' sets it, and 'yan ls' lists the tasks");
  }
  return task;
}

/** One incomplete task, as the select offers it. */
interface Open {
  readonly id: string;
  readonly title: string;
  readonly units: number;
  readonly shifts: number;
}

/** Every task in the queue that is not finished. */
export function openTasks(): Open[] {
  const queue = queueJson() as {
    tasks: { id: string; title: string; complete: boolean; units: unknown[]; shifts: number }[];
  };
  return queue.tasks
    .filter((t) => !t.complete)
    .map((t) => ({ id: t.id, title: t.title, units: t.units.length, shifts: t.shifts }));
}

/**
 * The argument, then `$YAN_TASK`, then a select among the tasks in progress —
 * and, with no terminal to ask in, a refusal naming the argument, so nothing
 * unattended hangs on an answer that is not coming.
 *
 * @throws CommandError `usage` when there is nothing to choose from, or no way
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
    throw CommandError.usage(command, `which task? pass it as the argument: '${ask.spelled} <task-id>'. Choosing interactively needs a terminal, and 'yan ls' lists the tasks`);
  }

  const open = openTasks();
  if (open.length === 0) {
    throw CommandError.usage(command, "there are no tasks in progress - 'yan ls' lists the finished ones");
  }

  const { chooseTask } = await import('../../ui/prompts.js');
  return chooseTask(open, ask.spelled, ask.question);
}
