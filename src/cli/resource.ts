import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { resourceLines } from './shared/resources.js';
import { requiredTask } from './shared/task-id.js';
import { RESOURCE_KINDS, isResourceKind } from '../records/task/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan resource` — what the work refers to, kept in task.json under a name
 * the agent chooses, as one of a few kinds. A kind is there because it has
 * its own moment to be kept and its own place on `user`'s screens; whatever
 * has neither is `general`. What a resource holds is never checked: a
 * ticket, a doc, a path are all a line of text. `yan context` and
 * `yan peek` list them.
 */

interface TaskOption {
  task?: string;
}

const TASK_FLAG = ['--task <id>', 'the task; defaults to $YAN_TASK'] as const;

const add = new Command('add')
  .description('keep one under a name; a name kept again is replaced')
  .argument('<kind>', `one of: ${RESOURCE_KINDS.join(' ')}`)
  .argument('<name>', "a short name of your choosing: PROJ-412, web#77, 'iPad playback page'")
  .argument('<where>', 'a URL, a path, whatever finds it')
  .option(...TASK_FLAG)
  .action(
    action('yan resource add', (kind: string, name: string, where: string, options: TaskOption) => {
      if (!isResourceKind(kind)) {
        throw YanError.usage('resource_usage', `'${kind}' is not a kind of resource - one of: ${RESOURCE_KINDS.join(' ')}; 'yan resource --help' says which is which`);
      }
      const task = requiredTask(options.task, '--task <id>');
      const replaced = task.addResource(kind, name, where);
      out(`${replaced ? 'replaced' : 'kept'} ${kind} ${name.trim()} → ${task.id}`);
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
  .description('every resource the task keeps, by kind')
  .option(...TASK_FLAG)
  .action(
    action('yan resource ls', (options: TaskOption) => {
      const lines = resourceLines(requiredTask(options.task, '--task <id>').read());
      if (lines.length === 0) out('no resources');
      for (const line of lines) out(line);
    }),
  );

export const command = new Command('resource')
  .description('what the work refers to, each kept under a name as one of: spec (ticket, PRD, design), mr, preview (a deployed test link), run (a sub-task elsewhere), general')
  .addCommand(add)
  .addCommand(rm)
  .addCommand(ls)
  .addHelpText(
    'after',
    `
  spec     where the task comes from: a ticket, a PRD, a design. Kept when
           the work starts from it, or when the user gives one.
  mr       a merge request, as soon as it is opened, however it was opened,
           one each, named for its repository and number: web#77, api!12.
  preview  a link that opens the deployed version, in the environment it is
           deployed to, at the place the change is seen. Kept after each
           deploy the user is to look at, named for what it shows, so the
           next deploy replaces it.
  run      a sub-task started on another platform, such as an agent run.
  general  anything else a later session may need to find again.

A resource is a pointer: what it is and where it is, nothing more. Where
things stand goes in the log, and a path that exists on one machine only is
no use to the next.`,
  );
