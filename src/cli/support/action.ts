import { isYanError } from '../../util/error.js';

/**
 * Wrap a subcommand body so that a `YanError` becomes the message and exit code
 * a person (or an agent reading stderr) already expects from the shell half:
 *
 *   ls: no such task: t042
 *
 * Exit codes are the MVP's, unchanged: 0 fine, 2 you called this wrongly, 1 it
 * did not work. Anything that is not a `YanError` is a bug in `yan` and is left
 * to propagate with its stack, because hiding it would make it harder to fix.
 */
export function action<A extends unknown[]>(
  name: string,
  body: (...args: A) => Promise<void> | void,
): (...args: A) => Promise<void> {
  return async (...args: A): Promise<void> => {
    try {
      await body(...args);
    } catch (err) {
      if (!isYanError(err)) throw err;
      process.stderr.write(`${name}: ${err.message}\n`);
      process.exit(err.exitCode);
    }
  };
}

/** Print one line to stdout. Kept in one place so nothing reaches for console. */
export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
