import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { yanHome } from '../../util/home.js';
import { normalizePath } from '../../util/paths.js';
import { CommandError } from './errors.js';

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
