import { Command } from 'commander';
import { action } from './shared/action.js';
import { checkSendLength, type LineSender } from './shared/pane-line.js';
import { Terminal } from '../externals/herdr/index.js';
import { Shift } from '../records/shift/index.js';
import { YanError } from '../util/error.js';

/**
 * `yan send <sid> "<line>"` — one line to a running shift, up to 1000
 * characters, text and Enter in a single submission. More than that goes in a
 * file whose path the line names.
 *
 * The pane comes from `run/meta.json`, and nothing is sent to a pane with no
 * live agent — the text would be typed into whatever shell is there.
 */

/**
 * Send one line to a shift's agent.
 *
 * @throws YanError `send_usage` for a missing sid, an empty line, a line with a
 *   newline in it, or one over the limit; `send_clocked_out` when the shift has
 *   clocked out; `send_no_pane` when its pane was never recorded, and
 *   `term_not_found` when the pane holds no live agent.
 */
export function sendLine(
  sid: string | undefined,
  line: string | undefined,
  task = '',
  terminal?: LineSender,
): void {
  if (sid === undefined || sid === '') {
    throw YanError.usage('send_usage', 'a shift id is required');
  }
  if (line === undefined) {
    throw YanError.usage('send_usage', 'a line is required - one instruction, in quotes');
  }
  if (line === '') {
    throw YanError.usage('send_usage', 'refusing to send an empty line');
  }
  if (line.includes('\n')) {
    throw YanError.usage('send_usage', 'a line is one line - a newline would submit it early; write the rest to a file and name its path in the line');
  }
  checkSendLength(line, 'send_usage');

  const shift = Shift.resolve(sid, task);
  if (!shift.isLive()) {
    throw new YanError('send_clocked_out', `shift ${sid} has clocked out - its run/ directory is gone, so there is no terminal left to talk to`,
    );
  }

  const pane = shift.meta().pane;
  if (pane === undefined) {
    throw new YanError('send_no_pane', `no terminal id in ${shift.run}/meta.json - dispatch records the id the seam printed, and a shift is never located by label`,
    );
  }

  (terminal ?? new Terminal()).send(pane, line);
}

export const command = new Command('send')
  .description('one line, up to 1000 characters, to a running shift')
  .argument('[sid]')
  .argument('[line]')
  .addHelpText(
    'after',
    `
One line of up to 1000 characters, never a newline. For more, write it to a
file and name the path in the line: "round 2 feedback is in <path>".

Herdr's \`agent prompt\` submits the text and the Enter together, so there is no
separate Enter to send, and no first Enter for the agent to swallow.
A pane with no live agent is refused rather than typed into.`,
  )
  .action(
    action('yan send', (sid: string | undefined, line: string | undefined) => {
      sendLine(sid, line);
    }),
  );
