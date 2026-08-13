import { isYanError } from '../../util/error.js';

/**
 * Wrap a subcommand body so a `YanError` becomes a line on stderr and an exit:
 *
 *   ls: no such task: t042
 *
 * 0 fine, 2 you called this wrongly, 1 it did not work. Anything that is not a
 * `YanError` propagates with its stack.
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

/** Print one line to stdout. */
export function out(line: string): void {
  process.stdout.write(`${line}\n`);
}
