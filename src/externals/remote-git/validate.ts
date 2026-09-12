import { existsSync, readFileSync, statSync } from 'node:fs';
import { recordOrNone } from '../../util/narrow.js';
import type { ProcessResult } from '../../util/process.js';
import type { MrCreateOptions, MrRef, RepoRef } from './types.js';
import { YanError } from '../../util/error.js';

/**
 * Everything the verbs check before they talk to a CLI, and the readers of
 * what comes back — including the two both providers map their payloads with.
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
 * The directory to run in, or undefined when the ref names none.
 *
 * @throws YanError `remote_git_usage` when `dir` is set but is not a directory.
 */
export function checkDir(ref: RepoRef): string | undefined {
  if (ref.dir === undefined || ref.dir === '') return undefined;
  let isDir = false;
  try {
    isDir = statSync(ref.dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw YanError.usage('remote_git_usage', `dir is not a directory: ${ref.dir}`);
  return ref.dir;
}

/**
 * The merge request reference, CR-stripped.
 *
 * @throws YanError `remote_git_usage` when it is missing.
 */
export function requireMr(ref: MrRef): string {
  if (ref.mr === undefined || ref.mr === '') {
    throw YanError.usage('remote_git_usage', 'mr is required - pass the merge request URL createMr returned, or its number',
    );
  }
  return ref.mr.replace(/\r/g, '');
}

/**
 * The merge request body: `bodyFile`'s contents, `body`, or `''`.
 *
 * @throws YanError `remote_git_usage` when both are given, or the file is missing.
 */
export function bodyText(options: MrCreateOptions): string {
  if (options.bodyFile !== undefined && options.bodyFile !== '') {
    if (options.body !== undefined && options.body !== '') {
      throw YanError.usage('remote_git_usage', 'body and bodyFile are alternatives - pass one');
    }
    if (!existsSync(options.bodyFile)) {
      throw YanError.usage('remote_git_usage', `bodyFile does not exist: ${options.bodyFile}`);
    }
    return readFileSync(options.bodyFile, 'utf8');
  }
  return options.body ?? '';
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

/** Write one line on stderr saying the host could not be asked. */
export function unreachable(what: string, fallback: string, result: ProcessResult): void {
  const detail = result.stderr.trim().replace(/\n/g, ' ');
  process.stderr.write(
    `remote-git: cannot ask the host about ${what} - reporting ${fallback}${detail === '' ? '' : ` (${detail})`}\n`,
  );
}
