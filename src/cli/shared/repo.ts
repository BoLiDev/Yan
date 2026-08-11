import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { yanHome } from '../../util/home.js';
import { readJsonIfPresent } from '../../util/json.js';
import { normalizePath } from '../../util/paths.js';
import { CommandError } from './errors.js';

export const DEFAULT_POOL_SIZE = 8;

/**
 * Which clone a `--repo` names.
 *
 * A repository is either registered under `$YAN_HOME/repos/<name>/` or given as
 * a path to a clone. Every command that takes `--repo` — or that reads one out
 * of a unit — resolves it the same way, and the answer is normalised because it
 * is compared against paths git and Herdr print (conventions §3).
 *
 * The main clone is read-only: the only write allowed inside it is `git fetch`
 * (boundaries.md §9.1). Resolving one here does not license anything else.
 */
export function repoDir(command: string, name: string, hint?: string): string {
  const inHome = join(yanHome(), 'repos', name);
  if (existsSync(inHome) && statSync(inHome).isDirectory()) return normalizePath(resolve(inHome));
  if (name !== '' && existsSync(name) && statSync(name).isDirectory()) {
    return normalizePath(resolve(name));
  }
  throw CommandError.usage(
    command,
    `unknown repository: ${name} - ${hint ?? "register it with 'yan repo-add', or pass the path to a clone"}`,
  );
}

/**
 * How many trees this repository's pool may hold.
 *
 * `pool_size` follows the repository, not the code, and it lives in
 * `mem/repos.json` — yan's own bookkeeping, which the pool module must not
 * read. So the command layer reads it and passes it in.
 *
 * The key is the clone's directory name, which is what `repoDir` last segment
 * gives you.
 */
export function poolSize(repoKey: string): number {
  const registry = readJsonIfPresent(join(yanHome(), 'mem', 'repos.json'));
  if (typeof registry !== 'object' || registry === null) return DEFAULT_POOL_SIZE;
  const entry = (registry as Record<string, unknown>)[repoKey];
  if (typeof entry !== 'object' || entry === null) return DEFAULT_POOL_SIZE;
  const size = (entry as Record<string, unknown>).pool_size;
  return typeof size === 'number' && Number.isInteger(size) && size > 0 ? size : DEFAULT_POOL_SIZE;
}

/** The clone directory plus the key `poolSize` wants, resolved once. */
export function repoTarget(command: string, name: string, hint?: string): { clone: string; key: string } {
  const dir = repoDir(command, name, hint);
  return { clone: dir, key: dir.slice(dir.lastIndexOf('/') + 1) };
}
