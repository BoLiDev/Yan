import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { editJson, initJson, readJsonIfPresent } from './json.js';
import { asRecord, asString, recordOrNone } from './narrow.js';
import { normalizePath } from './paths.js';

/**
 * `~/.yan/config.json` — which vault is active, where each one is, and where
 * this machine keeps its clone of each repository. Never committed anywhere.
 *
 *   { "version": 1,
 *     "active": "personal",
 *     "vaults": { "personal": "C:/workspace/project/yan-vault-personal" },
 *     "clones": { "github.com/org/web": "C:/workspace/project/web" } }
 *
 * A clone is keyed by `repoKey` of its URL, so every vault that registers the
 * repository finds the same one.
 *
 * Data access only: nothing here refuses a missing or broken registration, and
 * `util/vault.ts` decides what to do about one. `$YAN_MACHINE_DIR` overrides
 * the location, for tests.
 */

interface MachineConfig {
  readonly version: number;
  readonly active?: string;
  readonly vaults: Readonly<Record<string, string>>;
  readonly clones: Readonly<Record<string, string>>;
}

const EMPTY: MachineConfig = { version: 1, vaults: {}, clones: {} };

export function machineDir(): string {
  const override = process.env.YAN_MACHINE_DIR;
  const dir = override !== undefined && override !== '' ? override : join(homedir(), '.yan');
  return normalizePath(dir);
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

  const paths = (raw: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, path] of Object.entries(asRecord(raw))) {
      const p = set(path);
      if (p !== undefined) out[name] = normalizePath(p);
    }
    return out;
  };
  const vaults = paths(record.vaults);
  const clones = paths(record.clones);

  const active = set(record.active);
  return {
    version: typeof record.version === 'number' ? record.version : 1,
    ...(active === undefined ? {} : { active }),
    vaults,
    clones,
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

/**
 * Read-modify-write, atomically, creating the config and its directory if
 * needed. What `edit` returns is written whole, so a field an older yan wrote
 * (`clone_root`) is dropped on the first write.
 */
function editMachine(edit: (current: MachineConfig) => MachineConfig): void {
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

/** Where this machine keeps the clone of the repository `key` names, or `undefined`. */
export function cloneOf(key: string): string | undefined {
  return readMachine().clones[key];
}

/** Record where this machine keeps the clone of `key`, overwriting any path already there. */
export function linkClone(key: string, path: string): void {
  editMachine((current) => ({ ...current, clones: { ...current.clones, [key]: normalizePath(path) } }));
}
