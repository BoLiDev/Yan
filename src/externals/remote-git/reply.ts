import { recordOrNone } from '../../util/narrow.js';
import { YanError } from '../../util/error.js';

/**
 * Reading what a CLI printed: the two helpers both providers map their
 * payloads with, and the URL `createMr` finds in its output.
 */

/**
 * A CLI's JSON object, or `undefined` when the payload is neither. Both
 * mappers treat those the same: nothing usable came back.
 */
export function asObject(text: string): Record<string, unknown> | undefined {
  try {
    return recordOrNone(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** A field lower-cased for comparison; `''` for anything that is not a string. */
export function lower(value: unknown): string {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/**
 * The last match of `pattern` in `text`, CR-stripped.
 *
 * @throws YanError `remote_git_failed` when nothing matches.
 */
export function extractUrl(text: string, pattern: RegExp): string {
  const matches = text.match(pattern);
  if (matches === null || matches.length === 0) {
    throw new YanError('remote_git_failed', 'the host did not print a merge request URL - check the repository by hand',
    );
  }
  return (matches[matches.length - 1] ?? '').replace(/\r/g, '');
}
