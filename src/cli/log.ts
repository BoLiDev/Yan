import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { insideTask } from './shared/task-id.js';
import { Log, LOG_TYPES, isLogType } from '../records/log/index.js';
import { Task } from '../records/task/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan log <type> "<line>"` — append one entry to a task's log.md. The way
 * yan writes the lines no command writes for it, so every line has the shape
 * `yan session-start` filters by.
 */

export const command = new Command('log')
  .description("append one entry to a task's log.md")
  .argument('[type]', `one of: ${LOG_TYPES.join(' ')}`)
  .argument('[line]', 'the entry, on one line')
  .addHelpText(
    'after',
    `
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
    action('yan log', (type: string | undefined, line: string | undefined) => {
      if (type === undefined || !isLogType(type)) {
        throw YanError.usage('log_usage', `${type === undefined || type === '' ? 'a type is required' : `'${type}' is not a log type`} - one of: ${LOG_TYPES.join(' ')}`);
      }
      if (line === undefined || line.trim() === '') {
        throw YanError.usage('log_usage', 'the entry is required - say it in one line');
      }
      if (/[\r\n]/.test(line)) {
        throw YanError.usage('log_usage', 'an entry is one line - write several entries instead');
      }
      const task = insideTask('log');
      if (!Task.exists(task)) throw YanError.usage('log_usage', `no such task: ${task}`);

      const log = new Log(task);
      log.append(type, line);
      out(`${type} → ${log.file}`);
    }),
  );
