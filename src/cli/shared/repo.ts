import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { yanHome } from '../../util/home.js';
import { readJsonIfPresent } from '../../util/json.js';
import { normalizePath } from '../../util/paths.js';
import { localReposPath, reposPath, vaultDir } from '../../util/vault.js';
import { CommandError } from './errors.js';

export const DEFAULT_POOL_SIZE = 8;

/**
 * The registry, in two halves (v3 td repos.md §2).
 *
 *   <vault>/repos.json          url, mode_default, pool_size   — tracked
 *   <vault>/.local/repos.json   path                           — this machine
 *
 * The split is forced rather than chosen: a URL is true on every machine and a
 * path is true on one. One tracked file holding both means every machine
 * rewrites every other machine's paths on every push; one untracked file
 * holding both means a fresh clone of a vault does not know which repositories
 * the context even involves, and `task.json`'s `repo` field dangles.
 *
 * "Registered but not linked here" is therefore a normal state — it is what
 * every freshly cloned vault looks like — which is why the refusal below names
 * both `yan repo add` and `yan repo link` rather than assuming which one the
 * reader needs.
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
 * Everything the vault knows about, joined with what this machine knows.
 *
 * No vault means no registry, and not an error here: `--repo <path to a clone>`
 * has always worked and has nothing to do with a vault — `yan tree get` against
 * a bare path is how the pool is exercised before anything is set up. The
 * refusal, when one is due, comes from `repoDir` below, which asks for the
 * vault only once it has run out of other answers.
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
 * Which clone a `--repo` names.
 *
 * Three answers, in order: what this machine recorded, the argument itself when
 * it is a path, and a refusal. The middle one is not a leftover — passing the
 * path to a clone has always worked and is how a one-off is done.
 *
 * The main clone is read-only: the only write allowed inside it is `git fetch`
 * (boundaries.md §9.1). That rule did not change when the clone became one
 * `user` also works in; what changed is that a branch checked out there cannot
 * also be leased (repos.md §3), which the pool reports by name.
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

  // Registered in the vault, but this machine has never said where it is. The
  // ordinary state of a vault that arrived from another machine.
  if (entry !== undefined) {
    throw new CommandError(
      command,
      'repo_unlinked',
      `'${name}' is registered (${entry.url}) but not linked on this machine - 'yan repo add' where your clones live, or 'yan repo link ${name} <path>'`,
    );
  }

  // Out of answers. If the reason is that there is no vault at all, say that
  // rather than "unknown repository" — the registry cannot know a name when
  // there is no registry.
  vaultDir();
  throw CommandError.usage(
    command,
    `unknown repository: ${name} - ${hint ?? "register it with 'yan repo add', or pass the path to a clone"}`,
  );
}

/**
 * The clone, or `undefined` — for the callers that are guessing on purpose.
 *
 * `yan continue` listing directories to allow, and `yan shift done` working out
 * which unit a stranded lease belonged to, both ask about repositories that may
 * not resolve, and neither should fail because of it. A refusal there would
 * turn "one unit's clone is missing" into "the whole command stops".
 */
export function repoDirIfKnown(name: string): string | undefined {
  const path = lookup(name)?.path;
  return path !== undefined && isDir(path) ? path : undefined;
}

/**
 * How many trees this repository's pool may hold.
 *
 * `pool_size` follows the repository, not the code, and it lives in the vault's
 * registry — yan's own bookkeeping, which the pool module must not read. So the
 * command layer reads it and passes it in.
 *
 * The key is the clone's directory name, which is what `repoTarget` returns,
 * and it may not be the registered name; a repository registered under a
 * different name than its directory falls back to the default rather than
 * silently taking someone else's tuning.
 */
export function poolSize(repoKey: string): number {
  return lookup(repoKey)?.poolSize ?? DEFAULT_POOL_SIZE;
}

/** The clone directory plus the key `poolSize` wants, resolved once. */
export function repoTarget(command: string, name: string, hint?: string): { clone: string; key: string } {
  const dir = repoDir(command, name, hint);
  return { clone: dir, key: dir.slice(dir.lastIndexOf('/') + 1) };
}

/**
 * Where `yan repo add <url>` clones into, when this machine has said.
 *
 * Kept here rather than in `util/machine.ts` because the fallback is a command
 * layer decision: beside the mechanics clone, which is where `yan vault init`
 * also puts things, so a machine that never configured anything still has one
 * obvious place instead of two.
 */
export function defaultCloneRoot(): string {
  return normalizePath(join(yanHome(), '..'));
}

/** True when a directory looks like a git clone rather than an ordinary folder. */
export function isClone(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}
