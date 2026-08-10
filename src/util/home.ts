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
 * The subcommands that exist, derived from disk and never tabulated.
 *
 * `bin/yan` has the same rule and the same reason: the implementation phases
 * land in parallel and a central list would make every one of those merge
 * requests conflict in one file. During the migration a name may exist in
 * either half — `dist/cli/<name>.js` (ported) or `bin/yan-<name>.sh` (not yet)
 * — and `yan --help` has to list both, or the help output would shrink every
 * time a command moved.
 */
export interface Subcommands {
  readonly ported: readonly string[];
  readonly shell: readonly string[];
  readonly all: readonly string[];
}

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

export function subcommands(home: string): Subcommands {
  // Only the top level of dist/cli/ is subcommands. Shared CLI plumbing lives
  // one directory down, in src/cli/support/, precisely so that this stays a
  // derivation and never needs a list of exceptions.
  const ported = namesIn(join(home, 'dist', 'cli'), '', '.js', ['yan']);
  const shell = namesIn(join(home, 'bin'), 'yan-', '.sh', []);
  const all = [...new Set([...ported, ...shell])].sort();
  return { ported, shell, all };
}
