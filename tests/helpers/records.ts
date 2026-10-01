import { lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The records a test reads back, and the way it reports a command function's
 * outcome.
 */

export interface Attempt<T> {
  readonly code: number;
  readonly message: string;
  /** What `fn` returned, when it returned. */
  readonly value?: T;
}

/**
 * Call a function and report it the way the command layer would: a thrown
 * `YanError` becomes its exit code and message, and a return is code 0.
 */
export function attempt<T>(fn: () => T): Attempt<T> {
  try {
    return { code: 0, message: '', value: fn() };
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { code: e.exitCode ?? 1, message: e.message ?? '' };
  }
}

/**
 * Every entry under `dir`, directories included, as sorted paths relative to
 * it: compared before and after a command, it proves the command stored
 * nothing. With `mtime`, each entry's modification time too, so a file
 * rewritten with the same bytes shows. Symlinks are listed and not followed.
 */
export function snapshot(dir: string, options: { mtime?: boolean } = {}): string[] {
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      const st = lstatSync(full);
      found.push(relative(dir, full).replace(/\\/g, '/') + (options.mtime === true ? ` ${st.mtimeMs}` : ''));
      if (st.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return found.sort();
}
