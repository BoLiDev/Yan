import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { chosenTask } from './shared/task-id.js';
import { openPath } from './shared/opener.js';
import { Task } from '../records/task/index.js';
import { action, out } from './shared/action.js';
import { YanError } from '../util/error.js';

/**
 * `yan open <id> [--artifacts]` — print a task directory's absolute path, and
 * open it in the platform's file manager where there is one. Exits 0 whenever
 * the directory exists, printed path and all.
 *
 * `$YAN_OPENER` overrides the opener (`shared/opener.ts`); setting it empty
 * means the path is the whole answer.
 */

export const command = new Command('open')
  .description('open a task directory, or its artifacts/')
  .argument('[task-id]', 'the task; defaults to $YAN_TASK, or asks when there is a terminal')
  .option('--artifacts', 'open tasks/<id>/artifacts/ instead')
  .action(
    action('open', async (given: string | undefined, options: { artifacts?: boolean }) => {
      const id = await chosenTask('open', given, {
        spelled: 'yan open',
        question: 'Which task directory do you want to open?',
      });
      if (!Task.exists(id)) throw new YanError('task_missing', `no such task: ${id}`);

      let dir = new Task(id).dir;
      if (options.artifacts === true) {
        dir = join(dir, 'artifacts');
        mkdirSync(dir, { recursive: true });
      }
      if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        throw new YanError('open_failed', `not a directory: ${dir}`);
      }

      out(dir);
      openPath(dir);
    }),
  );
