import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
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
 *     "clones": { "github.com/org/web": "C:/workspace/project/web" },
 *     "skillDir": "~/work/skills" }
 *
 * A clone is keyed by `repoKey` of its URL, so every vault that registers the
 * repository finds the same one.
 *
 * `skillDir` is written by hand, never by yan: a plugin folder, or a list of
 * them, that claude is started with on this machine beside yan's own, for
 * skills such as the ones a workplace keeps. It is this machine's and not the
 * vault's, since the folder is only here.
 *
 * `terminals` is written by bare `yan` alone: each agent it started in a
 * herdr pane here, while the agent runs, so `yan serve` on this machine can
 * show the pane and type into it. A pane is only on this machine.
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
  /** As written, a path or a list of them, so a rewrite of the file keeps it as it was. */
  readonly skillDir?: string | readonly string[];
  readonly terminals?: readonly HeldTerminal[];
}

/** An agent bare `yan` started in a herdr pane: which task, which pane, and the socket herdr answers on. */
export interface HeldTerminal {
  readonly vault: string;
  readonly task: string;
  readonly pane: string;
  readonly socket: string;
  /** The herdr itself, which streams the pane. */
  readonly bin: string;
  /** claude, codex or agy. */
  readonly cli: string;
  /** When it started, as an ISO time. */
  readonly since: string;
}

function readTerminals(raw: unknown): HeldTerminal[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const r = asRecord(entry);
    const [vault, task, pane, socket] = [set(r.vault), set(r.task), set(r.pane), set(r.socket)];
    if (vault === undefined || task === undefined || pane === undefined || socket === undefined) return [];
    return [{ vault: normalizePath(vault), task, pane, socket, bin: set(r.bin) ?? 'herdr', cli: set(r.cli) ?? 'claude', since: set(r.since) ?? '' }];
  });
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
  const skillDir = typeof record.skillDir === 'string' ? record.skillDir
    : Array.isArray(record.skillDir) ? record.skillDir.filter((d): d is string => typeof d === 'string') : undefined;
  const terminals = readTerminals(record.terminals);
  return {
    version: typeof record.version === 'number' ? record.version : 1,
    ...(active === undefined ? {} : { active }),
    vaults,
    clones,
    ...(skillDir === undefined ? {} : { skillDir }),
    ...(terminals.length === 0 ? {} : { terminals }),
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

/**
 * The folders `skillDir` names, absolute and normalised, in the order given.
 * A leading `~` is the home directory, as a shell would read it, and so is
 * the start of any other path not absolute.
 */
export function skillDirs(): string[] {
  const { skillDir } = readMachine();
  const given = typeof skillDir === 'string' ? [skillDir] : skillDir ?? [];
  return given.map((d) => d.trim()).filter((d) => d !== '')
    .map((d) => normalizePath(resolve(homedir(), d.replace(/^~(?:[\\/]|$)/, ''))));
}

/** Keep that `held` runs in its pane, in place of any other agent kept for its task. */
export function holdTerminal(held: HeldTerminal): void {
  const vault = normalizePath(held.vault);
  editMachine((current) => ({
    ...current,
    terminals: [...(current.terminals ?? []).filter((t) => t.vault !== vault || t.task !== held.task), { ...held, vault }],
  }));
}

/** Forget the agent of `task` in `pane`, once it has exited; one started since in another pane stays. */
export function letTerminalGo(vault: string, task: string, pane: string): void {
  const at = normalizePath(vault);
  editMachine((current) => {
    const terminals = (current.terminals ?? []).filter((t) => t.vault !== at || t.task !== task || t.pane !== pane);
    const { terminals: _was, ...rest } = current;
    return terminals.length === 0 ? rest : { ...rest, terminals };
  });
}

/** The agents running in herdr panes for the tasks of the vault at `vault`, as bare `yan` kept them. */
export function terminalsOf(vault: string): HeldTerminal[] {
  const at = normalizePath(vault);
  return (readMachine().terminals ?? []).filter((t) => t.vault === at);
}
