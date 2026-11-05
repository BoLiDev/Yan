import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { requiredTask } from './shared/task-id.js';
import { saveVault } from './shared/vault-push.js';
import { SAY_MOST, type Task } from '../records/task/index.js';
import { localStamp } from '../util/time.js';
import { vaultDir } from '../util/vault.js';

/**
 * `yan say "<words>"` — what the agent tells `user` as it ends a turn, a
 * sentence or two: done, stuck, or waiting on them for something. yan
 * serve's page shows it to them wherever they are on it, in the toast that
 * says the agent finished, or in a bubble from the task's square on the
 * rail the task list folds to. Only the last is kept, in task.json, which
 * is committed and pushed at once, as a draft is: the push at the turn's
 * end is a hook's that only bare `yan` gives the agent it starts, and an
 * agent started any other way, in the cloud or under agy, has none, so its
 * words would stay where it runs. Bare, what was said last.
 */
export const command = new Command('say')
  .description('tell the user in a sentence or two, in their language, where things stand as you end a turn: done, stuck, or what you need from them')
  .argument('[words...]', 'what to say; without, what was said last')
  .option('--task <id>', 'the task; defaults to $YAN_TASK')
  .option('--json', 'what was said last as JSON, null when nothing was')
  .addHelpText(
    'after',
    `
yan serve's page shows it to the user wherever they are on it: in the
toast that says the agent finished, or with the task list folded, in a
bubble from the task's square. The vault is committed and pushed at once,
so it reaches a yan serve on any machine, from an agent in the cloud as
from one here; say it last, once the rest of the turn's notes are written.

Lines run into one, and it is at most ${SAY_MOST} columns, a Chinese or
Japanese character taking two: a sentence or two, not a report. Only the
last is kept, each in place of the one before.

  yan say "Retries are in and tested; the PR waits on your review."
  yan say "Stuck: the staging database refuses our key. Can you check the vault?"`,
  )
  .action(
    action('yan say', (words: string[], options: { task?: string; json?: boolean }) => {
      const task = requiredTask(options.task, '--task <id>');
      if (words.length === 0) {
        const said = task.read().said;
        if (options.json === true) out(JSON.stringify(said ?? null));
        else out(said === undefined ? 'nothing said yet' : `${localStamp(new Date(said.at))}  ${said.text}`);
        return;
      }
      const said = task.say(words.join(' '));
      const went = deliver(task);
      if (options.json === true) out(JSON.stringify(said));
      else out(`said → ${task.id}, ${went}`);
    }),
  );

/**
 * The vault committed and pushed with what was said, so serve fetches it
 * wherever it runs: what became of it, a push that failed leaving the
 * words kept here and saying so.
 */
function deliver(task: Task): 'pushed' | 'committed here' | 'not pushed' {
  try {
    return saveVault(vaultDir(), `${task.id}: said`).some((line) => line.includes(' → ')) ? 'pushed' : 'committed here';
  } catch (err) {
    process.stderr.write(`said, but the vault was not pushed: ${(err as Error).message}\n'yan vault push' tries again\n`);
    return 'not pushed';
  }
}
