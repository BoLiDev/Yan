import { existsSync, readFileSync } from 'node:fs';
import type { MrCreateOptions, MrRef, RepoRef } from './types.js';
import { YanError } from '../../util/error.js';
import { isDirectory } from '../../util/paths.js';

/**
 * Everything the verbs check before they talk to a CLI. Reading what comes
 * back is `reply.ts`.
 */

/**
 * The directory to run in, or undefined when the ref names none.
 *
 * @throws YanError `remote_git_usage` when `dir` is set but is not a directory.
 */
export function checkDir(ref: RepoRef): string | undefined {
  if (ref.dir === undefined || ref.dir === '') return undefined;
  if (!isDirectory(ref.dir)) throw YanError.usage('remote_git_usage', `dir is not a directory: ${ref.dir}`);
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
