import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { requiredTask } from './shared/task-id.js';
import { Log, LOG_TYPES, isLogType } from '../records/log/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan log` — what earlier sessions settled: every `agreed` and `changed`
 * line, and the last ten of any kind. `yan log <type> "<line>"` appends one.
 */

/** How many of the newest lines are shown whatever their type. */
const TAIL = 10;

export const command = new Command('log')
  .description('what earlier sessions settled; with a type and a line, record one')
  .argument('[type]', `one of: ${LOG_TYPES.join(' ')}`)
  .argument('[line]', 'the entry, on one line')
  .option('--task <id>', 'the task; defaults to $YAN_TASK')
  .addHelpText(
    'after',
    `
  agreed   a decision reached with the user, and why
  changed  something departs from what an earlier line said
  paused   work stopping: where it stands, what is left, what it waits on

Lines are dated today and never edited: a line that turns out wrong is
answered by a later 'changed' line.`,
  )
  .action(
    action('yan log', (type: string | undefined, line: string | undefined, options: { task?: string }) => {
      const task = requiredTask(options.task, '--task <id>');
      const log = new Log(task.id);

      if (type === undefined) {
        const { lines, total } = log.recall(TAIL);
        if (total === 0) {
          out('nothing logged yet');
          return;
        }
        if (lines.length < total) out(`(${total - lines.length} older lines left out: ${log.file})`);
        for (const l of lines) out(l);
        return;
      }

      if (!isLogType(type)) throw YanError.usage('log_usage', `'${type}' is not a log type - one of: ${LOG_TYPES.join(' ')}`);
      if (line === undefined || line.trim() === '') throw YanError.usage('log_usage', 'the entry is required - say it in one line');
      log.append(type, line);
      out(`${type} → ${task.id}`);
    }),
  );
