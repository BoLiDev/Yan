import { YanError, type YanErrorOptions } from '../../util/error.js';

/**
 * Something the command layer refused or could not finish.
 *
 * One class for the whole layer, and the command is a constructor argument
 * rather than a subclass. That is a deliberate exception to "every module names
 * its own error": below this layer a caller catches a specific kind because it
 * has to decide what to do about it — `TerminalError` and `WorktreeError` mean
 * different recoveries. Nothing catches a command error. It travels a few lines
 * to `action()`, which prints it and picks an exit code. Six classes here would
 * be six names carrying no decision.
 *
 * The code keeps the shell implementation's spelling — `tree_usage`,
 * `repo_clone_failed` — because that is what a caller and the bash half compare
 * against.
 */
export class CommandError extends YanError {
  public constructor(
    command: string,
    kind: string,
    message: string,
    options?: YanErrorOptions,
  ) {
    super(`${command}_${kind}`, message, options);
  }

  /** You invoked this wrongly. Always exit 2. */
  public static usage(command: string, message: string): CommandError {
    return new CommandError(command, 'usage', message, { exitCode: 2 });
  }
}
