import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { openingPromptNow } from './shared/launch.js';
import { chosenTask } from './shared/task-id.js';

/**
 * `yan debug` — what yan tells an agent, for `user` to read when an agent
 * does something it was not meant to: the opening prompt a start of the
 * task would give now, from the trees it holds on this machine.
 */

export const command = new Command('debug')
  .description('your look at what yan tells an agent: the opening prompt a start of the task would give now')
  .argument('[task-id]', 'defaults to $YAN_TASK, or asks at a terminal')
  .addHelpText(
    'after',
    `
The prompt is given to claude as --append-system-prompt, to codex as
developer_instructions and to agy as its first message. It is built from the
trees the task holds on this machine, each with the branch it is on now; a
repository with no tree here is left out, as a start leaves it when its tree
is declined.`,
  )
  .action(
    action('yan debug', async (given: string | undefined) => {
      out(openingPromptNow(await chosenTask(given, 'yan debug', 'Which task?')));
    }),
  );
