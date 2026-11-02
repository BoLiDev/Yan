import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { requiredTask } from './shared/task-id.js';
import { tildePath } from './shared/style.js';
import { returnTrees } from '../externals/worktree/index.js';
import { isClosed } from '../records/task/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan pause [task-id] [--force]` — put an open task aside, so nothing of it
 * takes room on this machine until it is taken up again: its trees go back
 * to the pool, and it is marked paused, its state kept, open or in review,
 * for `yan resume`. The trees go back first, and the guard there refuses
 * while any holds work that exists nowhere else, as `yan done` does; then
 * none is touched and the task is not paused. Work to come back to is
 * committed and pushed on the task's branch first, so the tree opened when
 * it is resumed, on any machine, is put back on it.
 */
export const command = new Command('pause')
  .description('put an open task aside: its worktrees go back to the pool, and it waits as it is for \'yan resume\' - commit and push its work first')
  .argument('[task-id]', 'defaults to $YAN_TASK')
  .option('--force', 'give the trees back even with uncommitted or unpushed work in them, which is lost')
  .addHelpText(
    'after',
    `
A paused task keeps its state, open or in review, and everything in its
folder; no agent is started on it, and 'yan' does not offer it, until
'yan resume' takes it up again. Its worktrees are given back as 'yan done'
gives them back: reset and cleaned, keeping what git ignores, and refused
while any has uncommitted changes, or commits no remote branch contains.
So commit and push the work on the task's branch, kept with 'yan branch',
before pausing: the tree opened for it once it is resumed, on any machine,
is put on the branch it kept last. --force throws away what is left.`,
  )
  .action(
    action('yan pause', (given: string | undefined, options: { force?: boolean }) => {
      const task = requiredTask(given, '<task-id>');
      const data = task.read();
      if (isClosed(data.state)) throw YanError.usage('task_closed', `${task.id} is ${data.state} - only an open task is paused`);
      if (data.pausedAt !== undefined) throw YanError.usage('task_paused', `${task.id} is paused already - 'yan resume ${task.id}' takes it up again`);
      const trees = returnTrees(task.id, { force: options.force === true });
      task.pause();
      out(`${task.id}  paused - 'yan resume ${task.id}' takes it up again`);
      for (const tree of trees) out(`  tree returned: ${tildePath(tree)}`);
    }),
  );
