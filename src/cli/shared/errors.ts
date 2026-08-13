import { YanError, type YanErrorOptions } from '../../util/error.js';

/**
 * Something the command layer refused or could not finish. One class for the
 * whole layer; `code` is `<command>_<kind>`, e.g. `tree_usage`.
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
