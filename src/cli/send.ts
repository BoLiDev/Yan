import { Command } from 'commander';
import { action } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { Terminal } from '../externals/herdr/index.js';
import { Shift } from '../records/shift/index.js';

/**
 * `yan send <sid> "<line>"` — one line to a running shift, up to 1000
 * characters, text and Enter in a single submission. More than that goes in a
 * file whose path the line names.
 *
 * The pane comes from `run/meta.json`, and nothing is sent to a pane with no
 * live agent — the text would be typed into whatever shell is there.
 */

/** The longest line this will send. */
function sendMax(): number {
  const raw = process.env.YAN_SEND_MAX;
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 1000;
}

/** What `yan send` needs from the terminal. `Terminal` is the real one. */
export interface Prompter {
  send(pane: string, text: string): void;
}

/**
 * Send one line to a shift's agent.
 *
 * @throws CommandError `usage` for a missing sid, an empty line, a line with a
 *   newline in it, or one over the limit; `clocked_out` when the shift has
 *   clocked out; `no_pane` when its pane was never recorded. TerminalError
 *   `notFound` when the pane holds no live agent.
 */
export function sendLine(
  sid: string | undefined,
  line: string | undefined,
  task = '',
  terminal?: Prompter,
): void {
  if (sid === undefined || sid === '') {
    throw CommandError.usage('send', 'a shift id is required');
  }
  if (line === undefined) {
    throw CommandError.usage('send', 'a line is required - one instruction, in quotes');
  }
  if (line === '') {
    throw CommandError.usage('send', 'refusing to send an empty line');
  }
  if (line.includes('\n')) {
    throw CommandError.usage('send', 'a line is one line - a newline would submit it early; write the rest to a file and name its path in the line');
  }
  const max = sendMax();
  if (line.length > max) {
    throw CommandError.usage('send', `that line is ${line.length} characters and the limit is ${max} - write the detail to a file and name its path in the line`,
    );
  }

  const shift = Shift.resolve(sid, task);
  if (!shift.isLive()) {
    throw new CommandError('send', 'clocked_out', `shift ${sid} has clocked out - its run/ directory is gone, so there is no terminal left to talk to`,
    );
  }

  const pane = shift.meta().agentId;
  if (pane === undefined) {
    throw new CommandError('send', 'no_pane', `no terminal id in ${shift.run}/meta.json - dispatch records the id the seam printed, and a shift is never located by label`,
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
--enter / --no-enter to retry, and no first Enter for the agent to swallow.
A pane with no live agent is refused rather than typed into.`,
  )
  .action(
    action('send', (sid: string | undefined, line: string | undefined) => {
      sendLine(sid, line);
    }),
  );
