import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { Shift } from '../records/shift/index.js';

/**
 * `yan report <state> "<note>"` — the shift → yan channel, and the only
 * command a shift needs. Appends one timestamped line to `run/status` and
 * touches `run/signal`, in one call, and touches nothing else.
 *
 * Five states, and any other is refused:
 *
 *   started         the agent booted and read its brief
 *   done            with the mode's deliverable in the note, e.g. `mr <url>`
 *   blocked         it is waiting on something
 *   needs-decision  it needs an answer from yan
 *   conflict        the merge has conflicts
 *
 * This is the half of supervision that does not depend on Herdr recognising a
 * screen: a shift that says it is blocked is believed either way.
 */

export const REPORT_STATES = ['started', 'done', 'blocked', 'needs-decision', 'conflict'] as const;

export type ReportState = (typeof REPORT_STATES)[number];

interface ReportOptions {
  sid?: string;
  task?: string;
  dir?: string;
}

export const command = new Command('report')
  .description('a shift tells yan what happened')
  .argument('[state]', `one of: ${REPORT_STATES.join(' ')}`)
  .argument('[note]', 'one short line saying what happened')
  .option('--sid <sid>', 'which shift is reporting (yan and tests only)')
  .option('--task <id>', 'the task it belongs to')
  .option('--dir <shift-dir>', 'the shift directory outright')
  .addHelpText(
    'after',
    `
usage: yan report <state> "<note>" [--sid <sid>] [--task <id>] [--dir <dir>]

Appends the event to run/status and touches run/signal in one go.

Which shift is reporting is normally taken from the environment the spawn
step set (YAN_SHIFT_DIR, or YAN_TASK_DIR plus YAN_SID); --sid / --dir are for
yan itself and for tests.`,
  )
  .action(
    action('report', (state: string | undefined, note: string | undefined, options: ReportOptions) => {
      // Checked first, so a refused state writes nothing at all.
      if (state === undefined || state === '') {
        throw CommandError.usage('report', `a state is required - one of: ${REPORT_STATES.join(' ')}`);
      }
      if (!(REPORT_STATES as readonly string[]).includes(state)) {
        throw CommandError.usage('report', `'${state}' is not a shift state - use one of: ${REPORT_STATES.join(' ')}`,
        );
      }
      if (note === undefined || note === '') {
        throw CommandError.usage('report', 'a note is required - say in one line what yan has to act on');
      }
      if (note.includes('\n')) {
        throw CommandError.usage('report', 'a note is one line - every line in run/status is one event, so a newline would forge a second one',
        );
      }

      // A shift reports about itself, so the id comes from its environment.
      let shift: Shift | undefined;
      if (options.dir !== undefined && options.dir !== '') {
        shift = Shift.fromDir(options.dir);
      } else if (options.sid !== undefined && options.sid !== '') {
        shift = Shift.resolve(options.sid, options.task ?? '');
      } else {
        shift = Shift.fromEnv();
      }
      if (shift === undefined) {
        throw CommandError.usage('report', 'cannot tell which shift is reporting - set YAN_SHIFT_DIR (or YAN_TASK_DIR and YAN_SID) as the spawn step does, or pass --sid <sid>',
        );
      }

      shift.appendEvent(state, note);
      out(`recorded ${state} in ${join(shift.run, 'status')}`);
    }),
  );
