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
  .option('--cli <cli>', 'the prompt this CLI would get, rather than the one the vault starts')
  .addHelpText(
    'after',
    `
claude is started with yan's plugin, whose skills say how to work in a task,
and its prompt only names them; it goes in as --append-system-prompt. codex
and agy take no plugin, so their prompt says it all: to codex as
developer_instructions, to agy as its first message. That one is built from
the trees the task holds on this machine, each with the branch it is on now;
a repository with no tree here is left out, as a start leaves it when its
tree is declined.`,
  )
  .action(
    action('yan debug', async (given: string | undefined, options: { cli?: string }) => {
      out(openingPromptNow(await chosenTask(given, 'yan debug', 'Which task?'), options.cli));
    }),
  );
