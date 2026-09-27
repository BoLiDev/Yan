import { Log, type LogType } from '../../records/log/index.js';
import { YanError } from '../../util/error.js';

/**
 * A command's `--note`: what the line it writes to log.md cannot say by
 * itself — what a piece of work is for, what it changed, why a field moved.
 * Checked before the command does anything, because the log line is written
 * after the work and a failure there only costs a line on stderr.
 *
 * @returns the note trimmed, or `''` when none was given.
 * @throws YanError `<command>_usage` when the note spans more than one line.
 */
export function readNote(command: string, note: string | undefined): string {
  const text = (note ?? '').trim();
  if (/[\r\n]/.test(text)) {
    throw YanError.usage(`${command}_usage`, '--note is one line - it becomes part of a single log.md entry');
  }
  return text;
}

/**
 * Append the entry narrating work a command has just done to the task's
 * log.md, with the note after it when there is one. Never fatal: the work
 * stands without its line, so a failure is one line on stderr naming the
 * command, and the command carries on.
 */
export function appendLog(command: string, task: string, type: LogType, line: string, note = ''): void {
  try {
    new Log(task).append(type, note === '' ? line : `${line} — ${note}`);
  } catch (err) {
    process.stderr.write(`${command}: the work is done, but log.md was not appended to - ${(err as Error).message}\n`);
  }
}
