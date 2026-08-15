import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the clone holding yan's own code is: `$YAN_HOME` when it is set and
 * holds a `bin/yan`, and this file's own location otherwise — so a stale
 * exported value is ignored rather than obeyed.
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

/** The names between `prefix` and `suffix` in `dir`, sorted; `[]` when unreadable. */
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

/** The subcommands that exist, read off the top level of `dist/cli/`. */
export function subcommands(home: string): string[] {
  return namesIn(join(home, 'dist', 'cli'), '', '.js', ['yan']);
}
