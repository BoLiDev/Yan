import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { Shift } from '../records/shift/index.js';

/**
 * `yan report <state> "<note>"` — the shift → yan channel (agents.md §5.4).
 *
 * This is a command rather than two sentences in the brief for one reason, and
 * §5.4 states it plainly: DO NOT COUNT ON AN AGENT REMEMBERING STEP TWO.
 * Appending the event and touching the wake marker is one command, so a shift
 * that reports at all reports completely. Wrapping it also buys three things
 * the brief could not enforce: the state is checked against the allowed words,
 * a timestamp is added, and the line is written atomically.
 *
 * It is the ONLY command a shift needs, and it stays inside the shift's write
 * boundary: it
 * touches `run/status` and `run/signal` and nothing else (boundaries.md §9.3).
 *
 * It also matters more than it did. Under Herdr it is no longer only the
 * shift's courtesy channel — it is the half of supervision that does not depend
 * on Herdr recognising a screen (supervision.md §1). A shift that says it is
 * blocked is believed whether or not any manifest matched.
 *
 * ---------------------------------------------------------------------------
 * THE FIVE ALLOWED STATES, and where they come from
 * ---------------------------------------------------------------------------
 *
 * §5.4 says "one of the five allowed words" but never lists all five. Three are
 * named outright and two are derived; the derivation is recorded here so the
 * next person changes the set on purpose rather than by accident:
 *
 *   done            §5.4 ("a shift reports `done`") and §8.2, whose three final
 *                   states — `done: report`, `done: branch <name>`,
 *                   `done: mr <url>` — are one state plus a deliverable. The
 *                   deliverable goes in the note: `yan report done "mr <url>"`.
 *   blocked         §5.4, named.
 *   needs-decision  §5.4, named.
 *   conflict        §5.4's wake table lists "the merge has conflicts" as its own
 *                   reason to wake the model. Of the events in that column it is
 *                   the only other one a shift discovers about itself — died,
 *                   stuck and red CI are all observed from outside.
 *   started         §5.3's first tier. One `started` line is positive proof that
 *                   the agent booted, read the brief and can call back at all —
 *                   which is precisely the thing yan has to act on when it never
 *                   arrives. Herdr's `agent start` confirmation narrowed the gap
 *                   this was covering but did not close it: the spike found
 *                   `interactive_ready: true` for an agent that had already
 *                   exited (evidence §11.7).
 *
 * Everything else is refused loudly. A sixth word would quietly become a sixth
 * meaning nobody handles.
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
      // The state is checked BEFORE anything is written, so a refused state
      // writes nothing at all.
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

      // Which shift is reporting. `yan report` takes no <sid> in normal use: a
      // shift reports about itself, and asking it to repeat its own id is one
      // more thing to get wrong.
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
