import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { yanHome } from '../../util/home.js';
import { readJsonIfPresent } from '../../util/json.js';
import { normalizePath } from '../../util/paths.js';
import { localReposPath, reposPath, vaultDir } from '../../util/vault.js';
import { CommandError } from './errors.js';

export const DEFAULT_POOL_SIZE = 8;

/**
 * The repository registry, in two halves:
 *
 *   <vault>/repos.json          url, mode_default, pool_size   — tracked
 *   <vault>/.local/repos.json   path                           — this machine
 *
 * "Registered but not linked here" is an ordinary state — it is what a freshly
 * cloned vault looks like.
 */

export interface RepoEntry {
  readonly name: string;
  readonly url: string;
  readonly modeDefault: string;
  readonly poolSize: number;
  /** Where it is on this machine, or `undefined` when nothing has said. */
  readonly path?: string;
}

function record(file: string): Record<string, unknown> {
  const raw = readJsonIfPresent(file);
  if (typeof raw !== 'object' || raw === null) return {};
  return raw as Record<string, unknown>;
}

function entriesOf(file: string): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(record(file))) {
    if (name === 'version') continue;
    if (typeof value === 'object' && value !== null) out[name] = value as Record<string, unknown>;
  }
  return out;
}

/**
 * Every registered repository, joined with what this machine knows, sorted by
 * name. No vault is an empty list, never a throw.
 */
export function registry(): RepoEntry[] {
  let portable: Record<string, Record<string, unknown>>;
  let local: Record<string, Record<string, unknown>>;
  try {
    portable = entriesOf(reposPath());
    local = entriesOf(localReposPath());
  } catch {
    return [];
  }

  return Object.keys(portable)
    .sort()
    .map((name) => {
      const entry = portable[name] as Record<string, unknown>;
      const path = (local[name] ?? {}).path;
      const size = entry.pool_size;
      return {
        name,
        url: typeof entry.url === 'string' ? entry.url : '',
        modeDefault: typeof entry.mode_default === 'string' ? entry.mode_default : 'mr',
        poolSize: typeof size === 'number' && Number.isInteger(size) && size > 0 ? size : DEFAULT_POOL_SIZE,
        ...(typeof path === 'string' && path !== '' ? { path: normalizePath(path) } : {}),
      };
    });
}

export function lookup(name: string): RepoEntry | undefined {
  return registry().find((r) => r.name === name);
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Which clone a `--repo` names: what this machine linked, or the argument
 * itself when it is the path of a directory.
 *
 * @throws CommandError `repo_missing` when the linked path is gone,
 *   `repo_unlinked` when it is registered but not linked here, `usage` when
 *   the name is unknown — or whatever `vaultDir()` throws when there is no
 *   vault to be registered in.
 */
export function repoDir(command: string, name: string, hint?: string): string {
  const entry = lookup(name);
  if (entry?.path !== undefined) {
    if (isDir(entry.path)) return entry.path;
    throw new CommandError(
      command,
      'repo_missing',
      `'${name}' is registered but ${entry.path} is not there any more - 'yan repo link ${name} <path>' says where it went`,
    );
  }

  if (name !== '' && isDir(name)) return normalizePath(resolve(name));

  if (entry !== undefined) {
    throw new CommandError(
      command,
      'repo_unlinked',
      `'${name}' is registered (${entry.url}) but not linked on this machine - 'yan repo add' where your clones live, or 'yan repo link ${name} <path>'`,
    );
  }

  // Throws first when the real problem is that there is no vault at all.
  vaultDir();
  throw CommandError.usage(
    command,
    `unknown repository: ${name} - ${hint ?? "register it with 'yan repo add', or pass the path to a clone"}`,
  );
}

/** The clone on this machine, or `undefined`. Never throws, unlike `repoDir`. */
export function repoDirIfKnown(name: string): string | undefined {
  const path = lookup(name)?.path;
  return path !== undefined && isDir(path) ? path : undefined;
}

/**
 * How many trees this repository's pool may hold, defaulting to
 * DEFAULT_POOL_SIZE.
 *
 * @param repoKey the clone's directory name, which `repoTarget` returns. A
 *   repository registered under some other name gets the default.
 */
export function poolSize(repoKey: string): number {
  return lookup(repoKey)?.poolSize ?? DEFAULT_POOL_SIZE;
}

/** The clone directory plus the key `poolSize` wants. Throws as `repoDir` does. */
export function repoTarget(command: string, name: string, hint?: string): { clone: string; key: string } {
  const dir = repoDir(command, name, hint);
  return { clone: dir, key: dir.slice(dir.lastIndexOf('/') + 1) };
}

/** Where clones go when this machine has not said: beside yan's own clone. */
export function defaultCloneRoot(): string {
  return normalizePath(join(yanHome(), '..'));
}

/** True when a directory holds a `.git`. */
export function isClone(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}
