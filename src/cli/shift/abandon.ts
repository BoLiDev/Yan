import { Command } from 'commander';
import { action, out } from '../shared/action.js';
import { appendLog } from '../shared/note.js';
import { describeShift, mrPhrase, requireConsent, tearDown, type AbandonDeps, type AbandonedShift } from '../shared/abandon.js';
import { Shift } from '../../records/shift/index.js';
import { YanError } from '../../util/error.js';

/**
 * `yan shift abandon <sid>` — giving one shift up. `yan abandon` in
 * `../abandon.ts` gives up a whole task, tearing each live shift down the same
 * way.
 */

interface ShiftAbandonOptions {
  task?: string;
  reason?: string;
  userAsked?: boolean;
  json?: boolean;
}

/**
 * `yan shift abandon <sid>` without the process around it.
 *
 * @throws YanError `shift_abandon_usage` without `--user-asked` or `--reason`, for a
 *   missing sid, or for a shift that has already clocked out.
 */
export function abandonShift(sid: string | undefined, options: ShiftAbandonOptions, deps: AbandonDeps = {}): AbandonedShift {
  if (sid === undefined || sid === '') throw YanError.usage('shift_abandon_usage', 'a shift id is required');
  const reason = requireConsent('shift_abandon', options.userAsked, options.reason);
  const shift = Shift.resolve(sid, options.task ?? '');
  if (!shift.isLive()) {
    throw YanError.usage('shift_abandon_usage', `shift ${shift.label()} is not live - run/ is gone, so there is nothing to abandon`);
  }

  const result = tearDown(shift, deps);
  if (shift.task !== '') {
    appendLog('yan shift abandon', shift.task, 'changed', `${result.sid} ${result.unit}  abandoned${mrPhrase(result)}`, reason);
  }
  return result;
}

export const shiftAbandonCommand = new Command('abandon')
  .description("give a shift up: close its merge request, kill its agent, discard its tree - only when user asks")
  .argument('[sid]')
  .option('--reason <text>', 'REQUIRED: one line saying why, for log.md')
  .option('--user-asked', 'REQUIRED: user said this work is to be given up')
  .option('--json', 'print the record instead of a summary')
  .addHelpText(
    'after',
    `
Closes the shift's merge request if it is still open, closes its pane and
checks the agent went, deletes run/, and returns its tree with anything
uncommitted in it. The brief, outcome.md and any pushed branch stay. Exit 1
when something is left to do by hand.`,
  )
  .action(
    action('yan shift abandon', (sid: string | undefined, options: ShiftAbandonOptions) => {
      const r = abandonShift(sid, options);
      if (options.json === true) out(JSON.stringify(r));
      const { lines, leftover } = describeShift(r);
      if (options.json !== true) for (const line of lines) out(line);
      if (leftover) process.exitCode = 1;
    }),
  );
