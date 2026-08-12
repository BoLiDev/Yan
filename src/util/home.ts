import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where `$YAN_HOME` is — this clone, the one holding the code.
 *
 *   an exported YAN_HOME wins, but only when it really is a yan home;
 *   otherwise it is derived from this file's own location.
 *
 * The env var is CHECKED rather than trusted because it is easy to inherit a
 * stale one from a shell that was opened in a different clone, and a yan home
 * pointing at the wrong tree fails in ways that look like anything but that.
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
 * `dist/cli/` already knows which commands exist, so a list here could only be
 * a second answer to the same question — and a second answer fails silently:
 * a command that runs but is missing from `--help`, or one announced in
 * `--help` that is not there. Adding a command is adding a file, and that is
 * the whole registration step.
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
