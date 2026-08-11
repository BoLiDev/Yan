import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where `$YAN_HOME` is. Same rule as `bin/yan`, so the two halves of the
 * migration can never disagree about it (runtime.md §2: `$YAN_HOME` is still
 * this clone).
 *
 *   an exported YAN_HOME wins — but only when it really is a yan home;
 *   otherwise it is derived from this file's own location.
 */

function looksLikeHome(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, 'bin', 'yan'));
  } catch {
    return false;
  }
}

export function yanHome(): string {
  const fromEnv = process.env.YAN_HOME;
  if (fromEnv && looksLikeHome(fromEnv)) return resolve(fromEnv);
  // dist/util/home.js → dist/util → dist → $YAN_HOME
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', '..');
}

/**
 * The subcommands that exist, DERIVED FROM DISK AND NEVER TABULATED.
 *
 * The rule outlived its first reason. It was written because the
 * implementation phases landed in parallel and a central list would have made
 * every one of them conflict in this file — and because during the migration a
 * name could exist in either half, so `yan --help` had to list both or shrink
 * every time a command moved. Both of those are over.
 *
 * It stays because of what it is: design principle 1, do not store state you
 * can derive. `dist/cli/` already knows which commands exist; a list here could
 * only ever be a second answer to that, and the failure of a second answer is
 * that it disagrees silently — a command that runs but is not in `--help`, or
 * one announced in `--help` that is not there.
 */
function namesIn(dir: string, prefix: string, suffix: string, skip: readonly string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const e of entries) {
    if (!e.startsWith(prefix) || !e.endsWith(suffix)) continue;
    const name = e.slice(prefix.length, e.length - suffix.length);
    if (name === '' || skip.includes(name)) continue;
    names.push(name);
  }
  return names.sort();
}

export function subcommands(home: string): string[] {
  // Only the top level of dist/cli/ is subcommands. What every command shares lives
  // one directory down, in src/cli/shared/, precisely so that this stays a
  // derivation and never needs a list of exceptions.
  return namesIn(join(home, 'dist', 'cli'), '', '.js', ['yan']);
}
