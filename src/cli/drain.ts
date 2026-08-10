import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Command } from 'commander';
import { CommandError } from './support/errors.js';
import { Supervision } from '../records/supervision/index.js';
import { action, out } from './support/action.js';

/**
 * `yan drain` — read the wake file and clear it (supervision.md).
 *
 * The first thing the model does after being woken. `yan wait` exits when
 * something actionable happened and writes the reason down; the wake file is
 * what carries that reason across the gap between "wait exited" and "the
 * model's next turn", because nothing else survives it.
 *
 * READ FIRST, CLEAR SECOND. The order is the whole design of this command: a
 * crash between the two leaves the reason on disk and the next drain picks it
 * up again, whereas clearing first and crashing loses it for good. Repeating a
 * wake is free; losing one means a shift waits for a yan that is never coming.
 *
 * An empty drain is normal and silent, and exits 0. Codex's checkpoint loop
 * drains after a quiet timeout too, so "nothing to report" must not look like a
 * failure.
 *
 * WHOSE WAKE FILE. Supervision is per-yan and a yan is per-task (agents.md
 * §5.2), so the file belongs to the task, not to any one shift:
 * `tasks/<id>/run/wake`, beside the guard's own `run/guard-failures`.
 * `$YAN_WAKE_FILE` overrides the path entirely.
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
      // Through the supervision record rather than by joining the path here:
      // `yan wait` writes this file and `yan drain` clears it, and two private
      // copies of where it lives is how the pair ends up pointing at different
      // files under $YAN_WAKE_FILE.
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
