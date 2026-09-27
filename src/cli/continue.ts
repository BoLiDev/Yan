import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { enterTask, renderEntered, type EnterOptions } from './shared/enter.js';
import { chosenTask } from './shared/task-id.js';

/**
 * `yan continue <id>` — start the main agent in the pane this was typed in, as
 * a child sharing its stdin, stdout and stderr. Creates no container and
 * focuses nothing.
 *
 * One yan per task: a per-task lock, whose live pid is the fact, holds for
 * exactly as long as the agent runs. A second `yan continue` on the same task
 * starts nothing and reports where the live one is; a lock whose owner is gone
 * is reclaimed.
 *
 * The workspace tokens are set before the agent starts and withdrawn when it
 * returns, so a yan killed outright leaves stale ones until the next
 * `yan continue` on that task overwrites them.
 *
 * Exit codes: 0 fine (including "already running, here is where"), 2 you
 * called this wrongly, otherwise the main agent's own status.
 */

export const command = new Command('continue')
  .description('start yan for a task, in this pane')
  .argument('[task-id]', 'the task; defaults to $YAN_TASK, or asks when there is a terminal')
  .option('--agent <cli>', 'override agents.yan for this run')
  .option('--json', 'print what happened instead of a summary')
  .addHelpText(
    'after',
    `
Starts the main agent in THIS pane. No workspace is created and there is
nothing to join: yan is already in the multiplexer \`user\` is already in.

A second yan on the same task is refused: when one is already running this
says where it is rather than spawning a duplicate.

With no id and a terminal, this asks which of the tasks in progress to open.
Without a terminal it refuses: pass the id.`,
  )
  .action(
    action('yan continue', async (positional: string | undefined, options: EnterOptions) => {
      const session = enterTask({
        ...options,
        task: await chosenTask('continue', positional, {
          spelled: 'yan continue',
          question: 'Which task do you want to continue?',
        }),
      });
      const { record } = session;

      if (options.json === true) out(JSON.stringify(record));
      else renderEntered(record);

      if (session.run !== undefined) {
        process.exitCode = session.run();
      } else if (record.refused === 'no-terminal') {
        // Starting the agent is the whole job here, so not doing it is a
        // failure - unlike `yan task new`, where the task was still created.
        process.exitCode = 2;
      }
    }),
  );
