import { existsSync, readFileSync, statSync } from 'node:fs';
import type { CliResult } from './client.js';
import { RemoteGitError } from './errors.js';
import type { MrCreateOptions, MrRef, RepoRef } from './types.js';

/**
 * Everything the verbs check before they talk to a CLI, and the two small
 * readers of what comes back.
 */

/**
 * Yan's own options. No `gh` or `glab` flag is ever accepted: every verb
 * declares the option names it takes and this refuses everything else, so a
 * caller cannot reach the provider's surface even by accident. The compiler
 * says the same thing; this is the runtime half, for a caller that arrived
 * through JSON or through `unknown`.
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

export function requireMr(ref: MrRef): string {
  if (ref.mr === undefined || ref.mr === '') {
    throw RemoteGitError.usage('mr is required - pass the merge request URL createMr returned, or its number',
    );
  }
  // A URL or a branch name that arrived from a JSON file read on Git Bash may
  // carry a carriage return, and it would turn into an unexplainable 404.
  return ref.mr.replace(/\r/g, '');
}

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

/** Callers get the URL and nothing else — never the CLI's prose around it. */
export function extractUrl(text: string, pattern: RegExp): string {
  const matches = text.match(pattern);
  if (matches === null || matches.length === 0) {
    throw new RemoteGitError('failed', 'the host did not print a merge request URL - check the repository by hand',
    );
  }
  return (matches[matches.length - 1] ?? '').replace(/\r/g, '');
}

/**
 * A query verb could not reach the host. It still has to answer with a member
 * of its closed set, so it says so on stderr and returns the safe one.
 */
export function unreachable(what: string, fallback: string, result: CliResult): void {
  const detail = result.stderr.trim().replace(/\n/g, ' ');
  process.stderr.write(
    `remote-git: cannot ask the host about ${what} - reporting ${fallback}${detail === '' ? '' : ` (${detail})`}\n`,
  );
}
