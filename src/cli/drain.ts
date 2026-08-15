import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Command } from 'commander';
import { CommandError } from './shared/errors.js';
import { Supervision } from '../records/supervision/index.js';
import { action, out } from './shared/action.js';

/**
 * `yan drain` — print the reasons `yan wait` wrote to `tasks/<id>/run/wake`,
 * then clear it. Read first and clear second, so a crash in between repeats a
 * wake rather than losing one.
 *
 * An empty drain is silent and exits 0. `$YAN_WAKE_FILE` overrides the path.
 */

export const command = new Command('drain')
  .description('read the wake file and clear it')
  .argument('[task-id]', 'defaults to $YAN_TASK')
  .option('--peek', 'print the reason without clearing it')
  .action(
    action('drain', (id: string | undefined, options: { peek?: boolean }) => {
      const task = id ?? process.env.YAN_TASK ?? '';
      const override = process.env.YAN_WAKE_FILE ?? '';
      if (task === '' && override === '') {
        throw CommandError.usage('drain', 'cannot tell whose wake file to drain - pass a task id, or set $YAN_TASK as the task container does',
        );
      }
      // Through the supervision record, which is also what `yan wait` writes.
      const wake = task === '' ? override : new Supervision(task).wake;

      if (!existsSync(wake)) return;

      // Read into memory before anything is removed.
      let reason: string;
      try {
        reason = readFileSync(wake, 'utf8');
      } catch (cause) {
        throw new CommandError('drain', 'failed', `cannot read the wake file: ${wake}`, { cause });
      }

      const trimmed = reason.replace(/\r?\n$/, '');
      if (trimmed !== '') out(trimmed);

      if (options.peek === true) return;

      try {
        rmSync(wake, { force: true });
      } catch (cause) {
        throw new CommandError('drain', 'failed', `the reason was printed but the wake file could not be cleared: ${wake}`,
          { cause },
        );
      }
    }),
  );
