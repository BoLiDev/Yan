import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { Log, LOG_TYPES, isLogType } from '../records/log/index.js';
import { Task } from '../records/task/index.js';

/**
 * `yan log <type> "<line>"` — append one entry to a task's log.md. The way
 * yan writes the lines no command writes for it, so every line has the shape
 * `yan session-start` filters by.
 */

export const command = new Command('log')
  .description("append one entry to a task's log.md")
  .argument('[type]', `one of: ${LOG_TYPES.join(' ')}`)
  .argument('[line]', 'the entry, on one line')
  .option('--task <id>', 'the task; defaults to $YAN_TASK')
  .addHelpText(
    'after',
    `
usage: yan log <type> "<line>" [--task <id>]

  agreed     a conclusion, plan or understanding reached with user
  started    a piece of work began, and what it is for
  delivered  a piece of work finished, and what it changed
  changed    what happened departs from what the log said before
  incident   something went wrong, and how it was resolved
  paused     work stopped: where, what is left, what it waits on

The date is today's. Nothing already in log.md can be changed: a line that
turns out to be wrong is answered by a later \`changed\` line.`,
  )
  .action(
    action('yan log', (type: string | undefined, line: string | undefined, options: { task?: string }) => {
      if (type === undefined || !isLogType(type)) {
        throw CommandError.usage('log', `${type === undefined || type === '' ? 'a type is required' : `'${type}' is not a log type`} - one of: ${LOG_TYPES.join(' ')}`);
      }
      if (line === undefined || line.trim() === '') {
        throw CommandError.usage('log', 'the entry is required - say it in one line');
      }
      if (/[\r\n]/.test(line)) {
        throw CommandError.usage('log', 'an entry is one line - write several entries instead');
      }
      const task = options.task ?? process.env.YAN_TASK ?? '';
      if (task === '') throw CommandError.usage('log', '--task is required (or set YAN_TASK)');
      if (!Task.exists(task)) throw CommandError.usage('log', `no such task: ${task}`);

      const log = new Log(task);
      log.append(type, line);
      out(`${type} → ${log.file}`);
    }),
  );
