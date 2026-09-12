import { existsSync, readFileSync } from 'node:fs';

/**
 * A stamp file: one line of space-separated fields, rewritten whole each time.
 * `run/pulse` and `run/beacon` are both one, and both are written by a loop
 * while something else reads them, so a read that lands mid-write must answer
 * "I do not know" rather than throw or half-parse.
 */

/** The fields of the first line; `undefined` when there is no readable file. */
export function readStamp(file: string): string[] | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return (readFileSync(file, 'utf8').replace(/\r/g, '').split('\n')[0] ?? '').split(' ');
  } catch {
    return undefined;
  }
}

/** The field at `index` when it is a whole number; `undefined` otherwise. */
export function stampNumber(fields: readonly string[], index: number): number | undefined {
  const field = fields[index];
  return field !== undefined && /^\d+$/.test(field) ? Number(field) : undefined;
}
