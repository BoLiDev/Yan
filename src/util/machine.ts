import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { editJson, initJson, readJsonIfPresent } from './json.js';
import { asRecord, asString, recordOrNone } from './narrow.js';
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

/** A configured value: a non-empty string, or nothing at all. */
function set(value: unknown): string | undefined {
  const text = asString(value);
  return text === '' ? undefined : text;
}

/** The registry, or an empty one when the file is missing or unreadable. Never throws. */
export function readMachine(): MachineConfig {
  const record = recordOrNone(readJsonIfPresent(machineConfigPath()));
  if (record === undefined) return EMPTY;

  const vaults: Record<string, string> = {};
  for (const [name, path] of Object.entries(asRecord(record.vaults))) {
    const p = set(path);
    if (p !== undefined) vaults[name] = normalizePath(p);
  }

  const active = set(record.active);
  const root = set(record.clone_root);
  return {
    version: typeof record.version === 'number' ? record.version : 1,
    ...(active === undefined ? {} : { active }),
    ...(root === undefined ? {} : { clone_root: normalizePath(root) }),
    vaults,
  };
}

let revision = 0;

/**
 * How many times this process has rewritten the registry. `util/vault.ts`
 * caches the vault it resolved and carries this in the key, so `yan vault use`
 * and `yan vault init` are seen by anything that asked before them.
 */
export function machineRevision(): number {
  return revision;
}

/** Read-modify-write, atomically, creating the config and its directory if needed. */
export function editMachine(edit: (current: MachineConfig) => MachineConfig): void {
  mkdirSync(machineDir(), { recursive: true });
  initJson(machineConfigPath(), EMPTY);
  editJson(machineConfigPath(), () => edit(readMachine()));
  revision += 1;
}

export function registeredVaults(): { name: string; path: string }[] {
  const { vaults } = readMachine();
  return Object.keys(vaults)
    .sort()
    .map((name) => ({ name, path: vaults[name] as string }));
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
