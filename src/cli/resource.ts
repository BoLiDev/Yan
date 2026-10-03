import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { resourceLines } from './shared/resources.js';
import { requiredTask } from './shared/task-id.js';

/**
 * `yan resource` — what the work refers to, kept in task.json under a name
 * the agent chooses. Nothing is assumed about what a resource is: a ticket,
 * a doc, a release, a path are all a line of text. `yan context` and
 * `yan peek` list them.
 */

interface TaskOption {
  task?: string;
}

const TASK_FLAG = ['--task <id>', 'the task; defaults to $YAN_TASK'] as const;

const add = new Command('add')
  .description('keep one under a name; a name kept again is replaced')
  .argument('<name>', 'a short name of your choosing: PROJ-412, design doc')
  .argument('<where>', 'a URL, a path, whatever finds it')
  .option(...TASK_FLAG)
  .action(
    action('yan resource add', (name: string, where: string, options: TaskOption) => {
      const task = requiredTask(options.task, '--task <id>');
      const replaced = task.addResource(name, where);
      out(`${replaced ? 'replaced' : 'kept'} ${name.trim()} → ${task.id}`);
    }),
  );

const rm = new Command('rm')
  .description('forget one')
  .argument('<name>', 'as `yan resource ls` shows it')
  .option(...TASK_FLAG)
  .action(
    action('yan resource rm', (name: string, options: TaskOption) => {
      const task = requiredTask(options.task, '--task <id>');
      task.removeResource(name);
      out(`removed ${name.trim()} → ${task.id}`);
    }),
  );

const ls = new Command('ls')
  .description('every resource the task keeps')
  .option(...TASK_FLAG)
  .action(
    action('yan resource ls', (options: TaskOption) => {
      const lines = resourceLines(requiredTask(options.task, '--task <id>').read().resources);
      if (lines.length === 0) out('no resources');
      for (const line of lines) out(line);
    }),
  );

export const command = new Command('resource')
  .description('what the work refers to - tickets, docs, releases, anything - each kept under a name')
  .addCommand(add)
  .addCommand(rm)
  .addCommand(ls)
  .addHelpText(
    'after',
    `
A resource is anything a later session may need to find again. yan does not
check what it is: a URL, a path or a ticket number is kept as it is given.`,
  );
