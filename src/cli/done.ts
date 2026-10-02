import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { existingTask, givenTask, openTasks } from './shared/task-id.js';
import { tildePath } from './shared/style.js';
import { isTty } from './shared/tty.js';
import { returnTrees } from '../externals/worktree/index.js';
import type { Task } from '../records/task/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan done [task-id] [--abandon <reason>] [--force]` — close a task and give
 * its trees back to the pool. The two are one event: a closed task holding a
 * tree keeps a slot leased for nothing.
 *
 * The trees go back first, and the guard there refuses while any holds work
 * that exists nowhere else; then none is touched and the task stays open.
 */

interface DoneOptions {
  abandon?: string;
  force?: boolean;
}

function close(task: Task, options: DoneOptions): void {
  const trees = returnTrees(task.id, { force: options.force === true });
  const abandoning = options.abandon !== undefined;
  task.close(abandoning ? 'abandoned' : 'done', options.abandon ?? '');
  out(`${task.id}  ${abandoning ? 'abandoned' : 'done'}`);
  for (const tree of trees) out(`  tree returned: ${tildePath(tree)}`);
}

/** The tasks to close: the one named, else a select at a terminal. */
async function chosen(given: string | undefined): Promise<Task[]> {
  const id = givenTask(given);
  if (id !== undefined) return [existingTask(id)];
  if (!isTty()) throw YanError.usage('task_usage', "which task? pass it: 'yan done <task-id>' - 'yan ls' lists them");
  const open = openTasks();
  if (open.length === 0) throw YanError.usage('task_usage', 'there are no open tasks');
  const { chooseTasksToFinish } = await import('../ui/prompts.js');
  return (await chooseTasksToFinish(open)).map(existingTask);
}

export const command = new Command('done')
  .description("close a task and return its worktrees to the pool")
  .argument('[task-id]', 'defaults to $YAN_TASK, or asks at a terminal')
  .option('--abandon <reason>', 'close it as given up, and say why')
  .option('--force', 'return the trees even with uncommitted or unpushed work in them, which is lost')
  .addHelpText(
    'after',
    `
Returning a tree resets and cleans it but keeps what git ignores, so the next
task in that slot starts with node_modules and build caches in place. It is
refused while any of the task's trees has uncommitted changes, or commits no
remote branch contains; then no tree is touched and the task stays open.
--force throws that work away; the branches themselves are never deleted.`,
  )
  .action(
    action('yan done', async (given: string | undefined, options: DoneOptions) => {
      if (options.abandon !== undefined && options.abandon.trim() === '') {
        throw YanError.usage('done_usage', '--abandon takes the reason the task is being given up');
      }
      for (const task of await chosen(given)) close(task, options);
    }),
  );
