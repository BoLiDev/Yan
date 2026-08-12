import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { YanError, type YanErrorOptions } from './error.js';
import { readJsonIfPresent } from './json.js';
import { activeVaultName, machineConfigPath, vaultPathOf } from './machine.js';
import { normalizePath } from './paths.js';

/**
 * Where a context's assets are.
 *
 * A **vault** is one context's task assets in a git repository you own: home
 * and work are two vaults, and a second machine opens the same one. This module
 * answers only "where are the tasks" — not where the code is, and not where
 * this machine's own state lives.
 *
 * Resolution mirrors `yanHome()` deliberately, because a rule that is the same
 * in both places is a rule nobody has to look up:
 *
 *   $YAN_VAULT             if it is set and really is a vault
 *   ~/.yan/config.json     the `active` entry, otherwise
 *   neither                a refusal naming `yan vault init`
 *
 * "Really is a vault" means `vault.json` is present, exactly as "really is a
 * home" means `bin/yan` is present. The env var is not only for tests: a work
 * machine can pin a terminal profile to the work vault and never depend on
 * global state.
 *
 * Throwing is a normal outcome here — a fresh install has no vault — so the
 * commands that must work without one (`doctor`, `vault init`, `vault clone`,
 * `vault ls`, `--help`) call `vaultDirIfAny()` or nothing at all.
 */

const CODES = {
  missing: 'vault_missing',
  invalid: 'vault_invalid',
  ahead: 'vault_ahead',
} as const;

export type VaultErrorKind = keyof typeof CODES;

export class VaultError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: VaultErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }
}

/** The newest `vault.json` version this build understands. */
export const VAULT_VERSION = 1;

/** The marker file. One name, used by the check and by `vault init` alike. */
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
 * Refuse a vault written by a newer yan.
 *
 * A silent downgrade is the one failure that corrupts rather than annoys: this
 * build would write the old shape over the new one and the newer machine would
 * find its own data quietly truncated.
 */
function checkVersion(dir: string): void {
  const { version } = readVaultJson(dir);
  if (version > VAULT_VERSION) {
    throw new VaultError(
      'ahead',
      `${dir} was written by a newer yan (vault.json version ${version}, this build understands ${VAULT_VERSION}) - update the mechanics clone`,
    );
  }
}

/** The active vault, or `undefined`. Never throws — for doctor and for `vault ls`. */
export function vaultDirIfAny(): string | undefined {
  const fromEnv = process.env.YAN_VAULT;
  if (fromEnv !== undefined && fromEnv !== '' && isVault(fromEnv)) {
    return normalizePath(resolve(fromEnv));
  }
  const active = activeVaultName();
  if (active === undefined) return undefined;
  const path = vaultPathOf(active);
  if (path === undefined || !isVault(path)) return undefined;
  return normalizePath(resolve(path));
}

/** The active vault, or a refusal that says what to do about it. */
export function vaultDir(): string {
  const found = vaultDirIfAny();
  if (found !== undefined) {
    checkVersion(found);
    return found;
  }

  const active = activeVaultName();
  if (active === undefined) {
    throw new VaultError(
      'missing',
      `no vault is registered on this machine - create one with 'yan vault init <name> --remote <url>', or take an existing one with 'yan vault clone <url>'`,
    );
  }
  const path = vaultPathOf(active);
  if (path === undefined) {
    throw new VaultError(
      'invalid',
      `${machineConfigPath()} makes '${active}' active but records no path for it - fix it with 'yan vault use <name>', or 'yan vault ls' to see what is registered`,
    );
  }
  throw new VaultError(
    'invalid',
    `the active vault '${active}' is not at ${path} any more - clone it again with 'yan vault clone <url>', or switch with 'yan vault use <name>'`,
  );
}

/*
 * The paths inside a vault, in one place.
 *
 * Every `join(vaultDir(), 'tasks')` in the code base would otherwise be a place
 * the layout is restated, and the layout is exactly the thing V3 moved.
 */

export function tasksDir(): string {
  return join(vaultDir(), 'tasks');
}

export function taskDir(id: string): string {
  return join(vaultDir(), 'tasks', id);
}

export function memDir(): string {
  return join(vaultDir(), 'mem');
}

/** `config.json` — agents.* and remote_git.*, which follow the context, not the disk. */
export function vaultConfigPath(): string {
  return join(vaultDir(), 'config.json');
}

/** The portable half of the registry: name → url, mode_default, pool_size. */
export function reposPath(): string {
  return join(vaultDir(), 'repos.json');
}

/** The machine half: name → this disk's clone path. Never committed. */
export function localReposPath(): string {
  return join(vaultDir(), '.local', 'repos.json');
}

/**
 * `skills/` — standing instructions, in prose, about what yan may do itself
 * here.
 *
 * not executables, and deliberately not: the machinery for running one would
 * be larger than the thing it runs. A skill is a few paragraphs saying "in
 * this environment you may check the build yourself rather than dispatching a
 * shift for it", and `yan session-start` reads them into the session, which is
 * the whole mechanism.
 *
 * In the vault, because what yan may do on its own is a property of the
 * context: at work there is a build command and a proxy and a rule about who
 * touches release branches; at home there is none of that. A machine-level
 * directory sits beside it for the things that really are about one box.
 */
export function skillsDir(): string {
  return join(vaultDir(), 'skills');
}
