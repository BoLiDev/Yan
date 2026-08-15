import { existsSync, readFileSync, statSync } from 'node:fs';
import type { CliResult } from './client.js';
import { RemoteGitError } from './errors.js';
import type { MrCreateOptions, MrRef, RepoRef } from './types.js';

/**
 * Everything the verbs check before they talk to a CLI, and the two small
 * readers of what comes back.
 */

/**
 * @throws RemoteGitError `usage` when `input` carries a defined key outside
 *   `allowed`, so no CLI flag can reach a provider.
 */
export function only(input: object, allowed: readonly string[]): void {
  const options = input as Record<string, unknown>;
  for (const key of Object.keys(options)) {
    if (options[key] === undefined) continue;
    if (!allowed.includes(key)) {
      throw RemoteGitError.usage(`'${key}' is not accepted here - these verbs take yan's own options only, never gh's or glab's`,
      );
    }
  }
}

/**
 * The directory to run in, or undefined when the ref names none.
 *
 * @throws RemoteGitError `usage` when `dir` is set but is not a directory.
 */
export function checkDir(ref: RepoRef): string | undefined {
  if (ref.dir === undefined || ref.dir === '') return undefined;
  let isDir = false;
  try {
    isDir = statSync(ref.dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw RemoteGitError.usage(`dir is not a directory: ${ref.dir}`);
  return ref.dir;
}

/**
 * The merge request reference, CR-stripped.
 *
 * @throws RemoteGitError `usage` when it is missing.
 */
export function requireMr(ref: MrRef): string {
  if (ref.mr === undefined || ref.mr === '') {
    throw RemoteGitError.usage('mr is required - pass the merge request URL createMr returned, or its number',
    );
  }
  return ref.mr.replace(/\r/g, '');
}

/**
 * The merge request body: `bodyFile`'s contents, `body`, or `''`.
 *
 * @throws RemoteGitError `usage` when both are given, or the file is missing.
 */
export function bodyText(options: MrCreateOptions): string {
  if (options.bodyFile !== undefined && options.bodyFile !== '') {
    if (options.body !== undefined && options.body !== '') {
      throw RemoteGitError.usage('body and bodyFile are alternatives - pass one');
    }
    if (!existsSync(options.bodyFile)) {
      throw RemoteGitError.usage(`bodyFile does not exist: ${options.bodyFile}`);
    }
    return readFileSync(options.bodyFile, 'utf8');
  }
  return options.body ?? '';
}

/**
 * The last match of `pattern` in `text`, CR-stripped.
 *
 * @throws RemoteGitError `failed` when nothing matches.
 */
export function extractUrl(text: string, pattern: RegExp): string {
  const matches = text.match(pattern);
  if (matches === null || matches.length === 0) {
    throw new RemoteGitError('failed', 'the host did not print a merge request URL - check the repository by hand',
    );
  }
  return (matches[matches.length - 1] ?? '').replace(/\r/g, '');
}

/** Write one line on stderr saying the host could not be asked. */
export function unreachable(what: string, fallback: string, result: CliResult): void {
  const detail = result.stderr.trim().replace(/\n/g, ' ');
  process.stderr.write(
    `remote-git: cannot ask the host about ${what} - reporting ${fallback}${detail === '' ? '' : ` (${detail})`}\n`,
  );
}
