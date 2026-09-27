import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { Task } from '../records/task/index.js';
import { pullVault } from './shared/vault-pull.js';
import { YanError } from '../util/error.js';
import { existingTask } from './shared/task-id.js';
import { clearSurfaced, rebuild, render } from './session-start/picture.js';
import { DRAFTS_SHOWN, LOG_TAIL, renderBriefing } from './session-start/briefing.js';

/**
 * `yan session-start` — rebuild the whole picture, and the SessionStart hook
 * for both harnesses.
 *
 *     scan tasks/  →  ask the terminal  →  ask the pool  →  ask the host
 *
 * Stores nothing, so a restart costs nothing and there is no file to disagree
 * with the world; its own test asserts `$YAN_HOME` is byte-for-byte
 * unchanged. The one thing it does write is a removal: a shift's
 * `run/undelivered` is printed and then deleted, because a report that has
 * been read is said — and only for the task this caller is the main agent
 * of. A source that will not answer costs one fact, reported as `unknown`,
 * and never a crash.
 *
 * This file is the arguments and the order; `session-start/picture.ts`
 * rebuilds and prints the picture, `session-start/briefing.ts` prints what
 * the main agent reads after it.
 */

export const command = new Command('session-start')
  .description('rebuild the picture from disk, the terminal, the pool and the forge')
  .argument('[task-id]', 'the task; defaults to $YAN_TASK, and to every task when that is unset')
  .option('--all', 'every task, even when $YAN_TASK is set')
  .option('--json', 'the same facts, machine readable: version 2')
  .addHelpText(
    'after',
    `
  (no id)   the task in $YAN_TASK, or every task when that is unset
  --all     every task, even when $YAN_TASK is set

For one task it also prints what the task remembers: brief.md, the newest
${DRAFTS_SHOWN} of user's drafts, every agreed and changed entry in log.md with
the last ${LOG_TAIL} of any kind, the index of mem/learnings/, and mem/user.md.

A source that cannot be reached is reported as \`unknown\` rather than being
treated as an error: a fresh machine has no Herdr server yet, and a train has
no forge. Nothing is stored, which is what makes restarting yan a non-event.

--json is version 2. Since version 1: an undelivered report's "at" is an
ISO 8601 string rather than epoch seconds.`,
  )
  .action(
    action('yan session-start', (positional: string | undefined, options: { all?: boolean; json?: boolean }) => {
      if (options.all === true && positional !== undefined && positional !== '') {
        throw YanError.usage('session_start_usage', '--all and a task id are alternatives');
      }
      const id = options.all === true ? '' : (positional ?? process.env.YAN_TASK ?? '');

      // Registered as the SessionStart hook, so a shift working on this
      // repository fires it too and would start with the main agent's whole
      // picture in its context. `YAN_SID` is set in a shift's environment and
      // never in the main agent's. `--json` is a caller asking on purpose.
      const sid = process.env.YAN_SID ?? '';
      if (sid !== '' && options.json !== true) {
        out(`shift ${sid} of task ${id === '' ? '(unknown)' : id}: the task picture belongs to the main agent, not to you - your brief is your work order.`);
        return;
      }

      // Caught up before the picture is rebuilt. Never fatal: a pull that
      // fails costs one line on stderr and the session continues on local
      // state.
      const pulled = pullVault();
      if (options.json === true && !pulled.ok) {
        process.stderr.write(`yan session-start: vault pull: ${pulled.message}\n`);
      }

      if (id !== '') existingTask('session_start', id);

      const picture = rebuild(id !== '' ? [id] : Task.list());
      if (options.json === true) {
        out(JSON.stringify(picture));
        clearSurfaced(picture);
        return;
      }
      if (render(picture, pulled)) {
        renderBriefing(id !== '' ? id : undefined, picture.tasks.find((t) => t.id === id)?.complete === true);
      }
      clearSurfaced(picture);
    }),
  );
