import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { YanError } from './error.js';
import { readJsonIfPresent } from './json.js';
import { machineConfigPath, machineRevision, readMachine } from './machine.js';
import { normalizePath } from './paths.js';

/**
 * Where the active vault is — one context's task assets, in a git repository
 * `user` owns.
 *
 *   $YAN_VAULT             when it is set and holds a vault.json
 *   ~/.yan/config.json     the `active` entry, otherwise
 *   neither                `vaultDir()` throws, `vaultDirIfAny()` says undefined
 *
 * A fresh install has no vault, so anything that must run without one —
 * `doctor`, `vault init`, `vault clone`, `vault ls`, `--help` — asks
 * `vaultDirIfAny()`.
 */

/** The newest `vault.json` version this build understands. */
export const VAULT_VERSION = 1;

/** The file whose presence makes a directory a vault. */
export const VAULT_MARKER = 'vault.json';

export function isVault(dir: string): boolean {
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, VAULT_MARKER));
  } catch {
    return false;
  }
}

export interface VaultIdentity {
  readonly version: number;
  readonly name: string;
  readonly created: string;
}

export function readVaultJson(dir: string): VaultIdentity {
  const raw = readJsonIfPresent(join(dir, VAULT_MARKER));
  const record = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    version: typeof record.version === 'number' ? record.version : 1,
    name: typeof record.name === 'string' ? record.name : '',
    created: typeof record.created === 'string' ? record.created : '',
  };
}

/**
 * @throws YanError `vault_ahead` when vault.json's version is newer than this
 *   build understands, so it is never written over with an older shape.
 */
function checkVersion(dir: string): void {
  const { version } = readVaultJson(dir);
  if (version > VAULT_VERSION) {
    throw new YanError('vault_ahead',
      `${dir} was written by a newer yan (vault.json version ${version}, this build understands ${VAULT_VERSION}) - update the mechanics clone`,
    );
  }
}

/**
 * The active vault, or `undefined`. Never throws, and never checks the
 * version.
 */
export function vaultDirIfAny(): string | undefined {
  const fromEnv = process.env.YAN_VAULT;
  if (fromEnv !== undefined && fromEnv !== '' && isVault(fromEnv)) {
    return normalizePath(resolve(fromEnv));
  }
  const { active, vaults } = readMachine();
  if (active === undefined) return undefined;
  const path = vaults[active];
  if (path === undefined || !isVault(path)) return undefined;
  return normalizePath(resolve(path));
}

/**
 * What the answer depends on. `Task`, `Shift` and `Supervision` each ask in
 * their constructor and `yan wait` builds them every few seconds, so the
 * resolved directory is cached against this rather than re-read three times a
 * call. A process never switches vaults of its own accord, and the two
 * variables plus the registry revision cover everything that could move the
 * answer under one that does — `yan vault use`, `init` and `clone` all write
 * through `editMachine`.
 */
function vaultKey(): string {
  return [
    process.env.YAN_VAULT ?? '',
    process.env.YAN_MACHINE_DIR ?? '',
    machineRevision(),
  ].join('\u0000');
}

let resolved: { key: string; dir: string } | undefined;

/**
 * The active vault.
 *
 * @throws YanError `vault_missing` when none is registered, `vault_invalid` when the
 *   registered one is not there, `vault_ahead` when it is too new for this build.
 */
export function vaultDir(): string {
  const key = vaultKey();
  if (resolved !== undefined && resolved.key === key) return resolved.dir;

  const found = vaultDirIfAny();
  if (found !== undefined) {
    checkVersion(found);
    resolved = { key, dir: found };
    return found;
  }

  // Only an answer is cached: a refusal is re-derived, so a vault that appears
  // mid-process is found rather than denied a second time.
  const { active, vaults } = readMachine();
  if (active === undefined) {
    throw new YanError('vault_missing',
      `no vault is registered on this machine - create one with 'yan vault init <name> --remote <url>', or take an existing one with 'yan vault clone <url>'`,
    );
  }
  const path = vaults[active];
  if (path === undefined) {
    throw new YanError('vault_invalid',
      `${machineConfigPath()} makes '${active}' active but records no path for it - fix it with 'yan vault use <name>', or 'yan vault ls' to see what is registered`,
    );
  }
  throw new YanError('vault_invalid',
    `the active vault '${active}' is not at ${path} any more - clone it again with 'yan vault clone <url>', or switch with 'yan vault use <name>'`,
  );
}

/* The paths inside a vault. Each throws exactly as `vaultDir()` does. */

export function tasksDir(): string {
  return join(vaultDir(), 'tasks');
}

export function taskDir(id: string): string {
  return join(vaultDir(), 'tasks', id);
}

export function memDir(): string {
  return join(vaultDir(), 'mem');
}

/** `config.json` — agents.* and remote_git.*, which follow the context. */
export function vaultConfigPath(): string {
  return join(vaultDir(), 'config.json');
}

/** `repos.json` — the portable half of the repo registry: name → url, pool_size. */
export function reposPath(): string {
  return join(vaultDir(), 'repos.json');
}

/** `.local/repos.json` — the machine half: name → this disk's clone path, never committed. */
export function localReposPath(): string {
  return join(vaultDir(), '.local', 'repos.json');
}

/**
 * `skills/` — standing instructions in prose, not executables, which
 * `yan session-start` lists. See `machineSkillsDir()` for the per-box ones.
 */
export function skillsDir(): string {
  return join(vaultDir(), 'skills');
}
