import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { requiredTask } from './shared/task-id.js';
import { shareChange } from './shared/vault-push.js';

/**
 * `yan resume [task-id]` — take a paused task up again, as it was: open or
 * in review. Its worktrees come back the next time an agent is started on
 * it, on the branch it kept last. The vault is committed and pushed at once,
 * as `yan pause` does.
 */
export const command = new Command('resume')
  .description('take a paused task up again, as it was before it was paused; \'yan\' opens its worktrees again')
  .argument('[task-id]', 'defaults to $YAN_TASK')
  .action(
    action('yan resume', (given: string | undefined) => {
      const task = requiredTask(given, '<task-id>');
      if (!task.resume()) {
        out(`${task.id} was not paused`);
        return;
      }
      out(`${task.id}  resumed - 'yan --task ${task.id}' starts its agent`);
      shareChange('resumed', `${task.id}: resumed`);
    }),
  );
