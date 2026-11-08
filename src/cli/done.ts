import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { existingTask, givenTask, openTasks } from './shared/task-id.js';
import { tildePath } from './shared/style.js';
import { isTty } from './shared/tty.js';
import { shareChange } from './shared/vault-push.js';
import { returnTrees } from '../externals/worktree/index.js';
import { isClosed, type Task } from '../records/task/index.js';
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

/**
 * Give the task's trees here back and close it; whether it was closed now.
 * One closed already, on another machine say, only has its trees here given
 * back: it stays as it was closed, its time and its reason with it.
 */
function close(task: Task, options: DoneOptions): boolean {
  const was = task.read().state;
  const trees = returnTrees(task.id, { force: options.force === true });
  const abandoning = options.abandon !== undefined;
  if (isClosed(was)) out(`${task.id}  ${was} already - left as it was`);
  else {
    task.close(abandoning ? 'abandoned' : 'done', options.abandon ?? '');
    out(`${task.id}  ${abandoning ? 'abandoned' : 'done'}`);
  }
  for (const tree of trees) out(`  tree returned: ${tildePath(tree)}`);
  return !isClosed(was);
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
--force throws that work away; a branch the agent cut is never deleted.
A task closed already, on another machine say, only has its trees here
given back, and stays as it was closed.

The vault is committed and pushed at once, so the other machines and yan
serve see the task closed.`,
  )
  .action(
    action('yan done', async (given: string | undefined, options: DoneOptions) => {
      if (options.abandon !== undefined && options.abandon.trim() === '') {
        throw YanError.usage('done_usage', '--abandon takes the reason the task is being given up');
      }
      const closed = (await chosen(given)).filter((task) => close(task, options));
      const how = options.abandon === undefined ? 'done' : 'abandoned';
      if (closed.length > 0) shareChange(how, `${closed.map((t) => t.id).join(', ')}: ${how}`);
    }),
  );
