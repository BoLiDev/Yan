import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { editJson, initJson, readJsonIfPresent } from './json.js';
import { normalizePath } from './paths.js';

/**
 * `~/.yan/config.json` — which vault is active, where each one is, and where
 * `yan repo add <url>` clones into. Never committed anywhere.
 *
 *   { "version": 1,
 *     "active": "personal",
 *     "clone_root": "C:/workspace/project",
 *     "vaults": { "personal": "C:/workspace/project/yan-vault-personal" } }
 *
 * Data access only: nothing here refuses a missing or broken registration, and
 * `util/vault.ts` decides what to do about one. `$YAN_MACHINE_DIR` overrides
 * the location, for tests.
 */

export interface MachineConfig {
  readonly version: number;
  readonly active?: string;
  readonly clone_root?: string;
  readonly vaults: Readonly<Record<string, string>>;
}

const EMPTY: MachineConfig = { version: 1, vaults: {} };

export function machineDir(): string {
  const override = process.env.YAN_MACHINE_DIR;
  const dir = override !== undefined && override !== '' ? override : join(homedir(), '.yan');
  return normalizePath(dir);
}

/**
 * `~/.yan/skills/` — standing instructions about this box rather than this
 * context. The vault's own `skillsDir()` holds the rest.
 */
export function machineSkillsDir(): string {
  return join(machineDir(), 'skills');
}

export function machineConfigPath(): string {
  return join(machineDir(), 'config.json');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The registry, or an empty one when the file is missing or unreadable. Never throws. */
export function readMachine(): MachineConfig {
  const raw = readJsonIfPresent(machineConfigPath());
  if (typeof raw !== 'object' || raw === null) return EMPTY;
  const record = raw as Record<string, unknown>;

  const vaults: Record<string, string> = {};
  const declared = record.vaults;
  if (typeof declared === 'object' && declared !== null) {
    for (const [name, path] of Object.entries(declared as Record<string, unknown>)) {
      const p = asString(path);
      if (p !== undefined) vaults[name] = normalizePath(p);
    }
  }

  return {
    version: typeof record.version === 'number' ? record.version : 1,
    ...(asString(record.active) === undefined ? {} : { active: asString(record.active) as string }),
    ...(asString(record.clone_root) === undefined
      ? {}
      : { clone_root: normalizePath(asString(record.clone_root) as string) }),
    vaults,
  };
}

/** Read-modify-write, atomically, creating the config and its directory if needed. */
export function editMachine(edit: (current: MachineConfig) => MachineConfig): void {
  mkdirSync(machineDir(), { recursive: true });
  initJson(machineConfigPath(), EMPTY);
  editJson(machineConfigPath(), () => edit(readMachine()));
}

export function registeredVaults(): { name: string; path: string }[] {
  const { vaults } = readMachine();
  return Object.keys(vaults)
    .sort()
    .map((name) => ({ name, path: vaults[name] as string }));
}

export function activeVaultName(): string | undefined {
  return readMachine().active;
}

export function vaultPathOf(name: string): string | undefined {
  return readMachine().vaults[name];
}

/** Where `yan repo add <url>` clones into, or undefined when it was never set. */
export function cloneRoot(): string | undefined {
  return readMachine().clone_root;
}

export function setCloneRoot(dir: string): void {
  editMachine((current) => ({ ...current, clone_root: normalizePath(dir) }));
}

/** Record a vault under `name`, overwriting any path already there. */
export function registerVault(name: string, path: string, activate = true): void {
  editMachine((current) => ({
    ...current,
    ...(activate ? { active: name } : {}),
    vaults: { ...current.vaults, [name]: normalizePath(path) },
  }));
}

export function setActiveVault(name: string): void {
  editMachine((current) => ({ ...current, active: name }));
}
