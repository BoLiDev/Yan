import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { editJson, initJson, readJsonIfPresent } from './json.js';
import { normalizePath } from './paths.js';

/**
 * The machine layer (v3 td INDEX.md §2).
 *
 * Three layers hold yan's state and this is the smallest of them: what is true
 * about THIS DISK and would be wrong on any other. Which vault is active, where
 * each one is, and where `yan repo add <url>` clones into. Nothing here is ever
 * committed anywhere, by anyone.
 *
 *   ~/.yan/config.json
 *   { "version": 1,
 *     "active": "personal",
 *     "clone_root": "C:/workspace/project",
 *     "vaults": { "personal": "C:/workspace/project/yan-vault-personal" } }
 *
 * This module is DATA ACCESS AND NOTHING ELSE — it reads, merges and writes,
 * and it refuses nothing. Every decision about a missing or broken registration
 * belongs to `util/vault.ts`, which is the layer above it. That split is what
 * keeps the two free of a cycle: vault knows about machine, never the reverse.
 *
 * `$YAN_MACHINE_DIR` overrides the location. It exists so a test can isolate
 * this layer the way it already isolates `$YAN_HOME` — a test that reads the
 * real `~/.yan` is a bug in the test — and it is not documented for users.
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

export function machineConfigPath(): string {
  return join(machineDir(), 'config.json');
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The registry, or an empty one. A missing or unreadable file is not an error here. */
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

/** Read-modify-write, atomically, creating `~/.yan/` on the way. */
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

/**
 * Where `yan repo add <url>` clones into.
 *
 * Undefined when it has never been set, and that stays a caller's problem: a
 * default invented here would be invented in a module that cannot ask.
 */
export function cloneRoot(): string | undefined {
  return readMachine().clone_root;
}

export function setCloneRoot(dir: string): void {
  editMachine((current) => ({ ...current, clone_root: normalizePath(dir) }));
}

/** Record a vault, and optionally make it the active one. Idempotent. */
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
