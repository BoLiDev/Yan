import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { deliverableLines } from './shared/deliverables.js';
import { terminalWidth } from './shared/style.js';
import { requiredTask } from './shared/task-id.js';
import type { Deliverable } from '../records/task/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan deliverable` — the solution, as what must be true once the task is
 * done, inside its task.json. One subcommand per move, so the record's shape never depends on
 * how somebody typed a bullet. `yan peek` lists them.
 */

interface TaskOption {
  task?: string;
}

const TASK_FLAG = ['--task <id>', 'the task; defaults to $YAN_TASK'] as const;

/** @throws YanError `deliverable_usage` when no id was given. */
function requireId(id: string | undefined, spelled: string): string {
  if (id === undefined || id.trim() === '') {
    throw YanError.usage('deliverable_usage', `which deliverable? ${spelled} - 'yan peek' lists them`);
  }
  return id.trim();
}

function show(items: readonly Deliverable[]): void {
  for (const line of deliverableLines(items, {}, terminalWidth())) out(line);
}

const add = new Command('add')
  .description('append one or several, in the order given')
  .argument('[text...]', 'each a statement of how things must be')
  .option(...TASK_FLAG)
  .action(
    action('yan deliverable add', (texts: string[] | undefined, options: TaskOption) => {
      show(requiredTask(options.task, '--task <id>').addDeliverables(texts ?? []));
    }),
  );

const edit = new Command('edit')
  .description('reword one, keeping its id and status')
  .argument('[id]', 'd1, d2…')
  .argument('[text]', 'the new text')
  .option(...TASK_FLAG)
  .action(
    action('yan deliverable edit', (id: string | undefined, text: string | undefined, options: TaskOption) => {
      const which = requireId(id, 'yan deliverable edit <id> "<text>"');
      show([requiredTask(options.task, '--task <id>').editDeliverable(which, text ?? '')]);
    }),
  );

const done = new Command('done')
  .description('mark one delivered: it has been seen to be true')
  .argument('[id]', 'd1, d2…')
  .option(...TASK_FLAG)
  .action(
    action('yan deliverable done', (id: string | undefined, options: TaskOption) => {
      const which = requireId(id, 'yan deliverable done <id>');
      show([requiredTask(options.task, '--task <id>').deliverableDone(which)]);
    }),
  );

const abandon = new Command('abandon')
  .description('give one up; the reason stops it being raised again')
  .argument('[id]', 'd1, d2…')
  .option('--reason <text>', 'required: why it is not being done')
  .option(...TASK_FLAG)
  .action(
    action('yan deliverable abandon', (id: string | undefined, options: TaskOption & { reason?: string }) => {
      const which = requireId(id, 'yan deliverable abandon <id> --reason "<why>"');
      if ((options.reason ?? '').trim() === '') throw YanError.usage('deliverable_usage', '--reason is required');
      show([requiredTask(options.task, '--task <id>').abandonDeliverable(which, options.reason ?? '')]);
    }),
  );

export const command = new Command('deliverable')
  .description('the solution: how things must be once the problem is solved - change it only when the user agrees to a different one')
  .addCommand(add)
  .addCommand(edit)
  .addCommand(done)
  .addCommand(abandon)
  .addHelpText(
    'after',
    `
A deliverable is one part of the solution: a way the product must be once
the task is done, stated so it can be checked: "the page's scripts load in
parallel", not "rewrite the loader with Promise.all". It says what is
different, never how the code is changed to make it so.

The list is the solution as the user agreed it, as it stands now. When they
settle on a different one, change the list so it reads as if first written
that way: reword with 'edit', 'abandon' what is no longer part of it, and
leave how it used to be to the log. They see the list after it changes.`,
  );
