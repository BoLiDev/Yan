import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { requiredTask } from './shared/task-id.js';
import { Log, LOG_TYPES, isLogType } from '../records/log/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan log` — how the task moved: every line on its scope, and the last
 * ten of any kind. `yan log <type> "<line>"` appends one.
 */

/** How many of the newest lines are shown whatever their type. */
const TAIL = 10;

export const command = new Command('log')
  .description('how the task moved: why its scope changed, and the steps toward its deliverables; with a type and a line, record one - never a point settled in a discussion, which is its document\'s')
  .argument('[type]', `one of: ${LOG_TYPES.join(' ')}`)
  .argument('[line]', 'the entry, on one line')
  .option('--task <id>', 'the task; defaults to $YAN_TASK')
  .addHelpText(
    'after',
    `
  scope     the task's scope moved: what was added, dropped or put off, and why
  progress  a step toward a deliverable: what was done, or tried and did not work
  paused    work stopping: where it stands, what is left, what it waits on

The log says how the task moved, in plain words: that a thing was done, that
it was tried and failed, that the task now covers more or less than it did.
It is not where a design or a discussion is kept: a point settled while a
document is worked out is in the document, and gets no line. Most turns add
none.

Lines are dated today and never edited: a line that turns out wrong is
answered by a later line. A log from before these types also holds
'agreed' and 'changed' lines, which are read and no longer written.`,
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
