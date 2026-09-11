import { CommandError } from './errors.js';

/**
 * A command's `--note`: what the line it writes to log.md cannot say by
 * itself — what a piece of work is for, what it changed, why a field moved.
 * Checked before the command does anything, because the log line is written
 * after the work and a failure there is swallowed.
 *
 * @returns the note trimmed, or `''` when none was given.
 * @throws CommandError `usage` when the note spans more than one line.
 */
export function readNote(command: string, note: string | undefined): string {
  const text = (note ?? '').trim();
  if (/[\r\n]/.test(text)) {
    throw CommandError.usage(command, '--note is one line - it becomes part of a single log.md entry');
  }
  return text;
}

/** `line`, with the note after it when there is one. */
export function noted(line: string, note: string): string {
  return note === '' ? line : `${line} — ${note}`;
}
