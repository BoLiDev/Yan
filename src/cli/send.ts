import { Command } from 'commander';
import { action } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { Terminal } from '../externals/herdr/index.js';
import { Shift } from '../records/shift/index.js';

/**
 * `yan send <sid> "<line>"` — yan → shift, while it is running (agents.md §5.4).
 *
 * One short line. The long contract was written once, into
 * `shifts/<sid>/brief.md`, and anything long that comes up afterwards goes into
 * a file: write the file, send the path. A wall of text typed into a running
 * agent's prompt is how the terminal ends up with half a paragraph in it and
 * the agent with the other half.
 *
 * ---------------------------------------------------------------------------
 * THE TWO-STEP IS GONE, AND ITS GUARD IS REPLACED
 * ---------------------------------------------------------------------------
 *
 * The MVP typed the text and pressed Enter as two retryable calls, because tmux
 * `send-keys` could not do both atomically and agent CLIs routinely swallow the
 * first Enter while they are still painting their input box. Herdr's
 * `agent prompt` submits text and Enter in one call, honouring the pane's live
 * bracketed-paste mode, so the split has nothing left to do and `--enter` /
 * `--no-enter` go with it (orchestration.md §5).
 *
 * What replaces it is a different guard, and it is the one that now matters:
 * NOTHING IS SENT TO A PANE WITHOUT A LIVE AGENT. A prompt to a pane whose
 * agent has died is typed into whatever shell is there, which then tries to run
 * it as a command (evidence §11.7). The seam refuses; this command reports it.
 * A dead shift is a `died:` wake, not a retry.
 *
 * The pane id comes from `run/meta.json`, never a label — a label is not a
 * source of truth (agents.md §5.7 practice 1).
 */

/**
 * One line to a prompt, not a document. Long enough for a real instruction,
 * short enough that "put it in a file and send the path" stays the habit.
 */
function sendMax(): number {
  const raw = process.env.YAN_SEND_MAX;
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 500;
}

/** What `yan send` needs from the terminal. `Terminal` is the real one. */
export interface Prompter {
  send(pane: string, text: string): void;
}

/** The command without the process around it: everything that decides is here. */
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
--enter / --no-enter to retry: the split the MVP needed was a tmux limitation.
A pane with no live agent is refused rather than typed into.`,
  )
  .action(
    action('send', (sid: string | undefined, line: string | undefined, options: { task?: string }) => {
      sendLine(sid, line, options.task ?? '');
    }),
  );
