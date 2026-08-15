import { Command } from 'commander';
import { action } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { Terminal } from '../externals/herdr/index.js';
import { Shift } from '../records/shift/index.js';

/**
 * `yan send <sid> "<line>"` — one short line to a running shift, text and
 * Enter in a single submission. Anything long goes in a file: send the path.
 *
 * The pane comes from `run/meta.json`, and nothing is sent to a pane with no
 * live agent — the text would be typed into whatever shell is there.
 */

/** The longest line this will send. */
function sendMax(): number {
  const raw = process.env.YAN_SEND_MAX;
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 500;
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
    throw CommandError.usage('send', 'a line is required - one short instruction, in quotes');
  }
  if (line === '') {
    throw CommandError.usage('send', 'refusing to send an empty line');
  }
  if (line.includes('\n')) {
    throw CommandError.usage('send', 'a line is one line - write the long version to a file and send its path');
  }
  const max = sendMax();
  if (line.length > max) {
    throw CommandError.usage('send', `that line is ${line.length} characters and the limit is ${max} - write it to a file and send the path instead`,
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
  .description('one short line to a running shift')
  .argument('[sid]')
  .argument('[line]')
  .option('--task <id>', 'the task the shift belongs to')
  .addHelpText(
    'after',
    `
usage: yan send <sid> "<line>" [--task <id>]

  one short line; anything long goes in a file and only the path is sent.

Herdr's \`agent prompt\` submits the text and the Enter together, so there is no
--enter / --no-enter to retry, and no first Enter for the agent to swallow.
A pane with no live agent is refused rather than typed into.`,
  )
  .action(
    action('send', (sid: string | undefined, line: string | undefined, options: { task?: string }) => {
      sendLine(sid, line, options.task ?? '');
    }),
  );
