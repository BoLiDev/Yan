import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Command } from 'commander';
import { Supervision } from '../records/supervision/index.js';
import { action, out } from './shared/action.js';
import { YanError } from '../util/error.js';

/**
 * `yan drain` — print the reasons `yan wait` wrote to `tasks/<id>/run/wake`,
 * then clear it. Read first and clear second, so a crash in between repeats a
 * wake rather than losing one.
 *
 * An empty drain is silent and exits 0. `$YAN_WAKE_FILE` overrides the path.
 *
 * `drainWake` is the whole of it, and `yan wait --drain` calls this one rather
 * than keeping a second copy: two implementations of "read it and clear it"
 * are two answers to what a wake means.
 */

/** Where a task's wake file is, honouring the override. */
function wakeFile(task: string): string {
  const override = process.env.YAN_WAKE_FILE ?? '';
  if (task === '' && override === '') {
    throw YanError.usage('drain_usage', 'cannot tell whose wake file to drain - pass a task id, or set $YAN_TASK as the task container does',
    );
  }
  // Through the supervision record, which is also what `yan wait` writes.
  return task === '' ? override : new Supervision(task).wake;
}

/**
 * Every reason waiting in the task's wake file, which is then cleared, or
 * `undefined` when there is no file. `peek` reads without clearing.
 *
 * @throws YanError `drain_failed` when the file cannot be read, or was printed
 *   and could not be cleared.
 */
export function drainWake(task: string, options: { peek?: boolean } = {}): string | undefined {
  const wake = wakeFile(task);
  if (!existsSync(wake)) return undefined;

  // Read into memory before anything is removed.
  let reason: string;
  try {
    reason = readFileSync(wake, 'utf8');
  } catch (cause) {
    throw new YanError('drain_failed', `cannot read the wake file: ${wake}`, { cause });
  }
  const trimmed = reason.replace(/\r?\n$/, '');

  if (options.peek === true) return trimmed;

  try {
    rmSync(wake, { force: true });
  } catch (cause) {
    throw new YanError('drain_failed', `the reason was printed but the wake file could not be cleared: ${wake}`,
      { cause },
    );
  }
  return trimmed;
}

export const command = new Command('drain')
  .description('read the wake file and clear it')
  .argument('[task-id]', 'defaults to $YAN_TASK')
  .option('--peek', 'print the reason without clearing it')
  .action(
    action('drain', (id: string | undefined, options: { peek?: boolean }) => {
      const reason = drainWake(id ?? process.env.YAN_TASK ?? '', { peek: options.peek === true });
      if (reason !== undefined && reason !== '') out(reason);
    }),
  );
