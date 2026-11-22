import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { editJson, initJson, readJsonIfPresent } from './json.js';
import { asRecord, asString, recordOrNone } from './narrow.js';
import { normalizePath, pathKey } from './paths.js';

/**
 * `~/.yan/config.json` — which vault is active, where each one is, and where
 * this machine keeps its clone of each repository. Never committed anywhere.
 *
 *   { "version": 1,
 *     "vaults": [
 *       { "name": "team", "path": "C:/workspace/project/yan-vault-team", "type": "remote" },
 *       { "name": "work", "path": "C:/workspace/project/yan-vault-work", "type": "local" } ],
 *     "clones": { "github.com/org/web": "C:/workspace/project/web" },
 *     "skillDir": "~/work/skills" }
 *
 * `vaults` is every vault this machine has, in order, and the order means
 * something: yan shows the tasks of all of them as one list, a task id two
 * vaults both have is the earlier vault's, and the first is the active one,
 * where a new task is made and whose drafts, learnings and config.json are
 * read. `type` is `local` for a vault kept on this machine alone and
 * `remote` for one kept in step with its origin. A file from before the
 * list, a map of name to path with `active` and `localVaults` beside it, is
 * read as the same thing, the active vault first, and written back as the
 * list.
 *
 * A clone is keyed by `repoKey` of its URL, so every vault that registers the
 * repository finds the same one.
 *
 * `skillDir` is written by hand, never by yan: a plugin folder, or a list of
 * them, that claude is started with on this machine beside yan's own, for
 * skills such as the ones a workplace keeps. It is this machine's and not the
 * vault's, since the folder is only here.
 *
 * Nothing is fetched from a `local` vault's origin or pushed to it,
 * whatever origin its git has (`util/vault.ts`, `vaultOrigin`). It is this
 * machine's and not the vault's: a setting inside the vault would have to
 * travel to mean anything, which is what it forbids. `localVaults`, paths,
 * says the same of a vault that is not in the list, one `$YAN_VAULT` points
 * at.
 *
 * `terminals` is written by bare `yan` alone: each agent it started in a
 * herdr pane here, while the agent runs, so `yan serve` on this machine can
 * show the pane and type into it. A pane is only on this machine.
 *
 * `worktreeTabs` is written by `yan serve` alone: the herdr tab it opened for
 * each of a task's worktrees, a shell in it, so the page goes back to the
 * same tab however often it is asked for, across a restart of serve too.
 *
 * Data access only: nothing here refuses a missing or broken registration, and
 * `util/vault.ts` decides what to do about one. `$YAN_MACHINE_DIR` overrides
 * the location, for tests.
 */

interface MachineConfig {
  readonly version: number;
  /** The first of `vaults`. */
  readonly active?: string;
  /** Name to path, in the order of the file's list: the order they are shown and looked through in. */
  readonly vaults: Readonly<Record<string, string>>;
  readonly clones: Readonly<Record<string, string>>;
  /** As written, a path or a list of them, so a rewrite of the file keeps it as it was. */
  readonly skillDir?: string | readonly string[];
  readonly localVaults?: readonly string[];
  readonly terminals?: readonly HeldTerminal[];
  readonly worktreeTabs?: readonly WorktreeTab[];
}

/** The herdr tab `yan serve` opened for one of a task's worktrees on this machine: which task, which tree, which tab, and the socket herdr answers on. */
export interface WorktreeTab {
  readonly vault: string;
  readonly task: string;
  /** The worktree, its path, which the tab's shell started in. */
  readonly tree: string;
  /** The repository's name, which the tab is called by. */
  readonly name: string;
  readonly tab: string;
  readonly socket: string;
  /** The herdr itself, which streams its panes. */
  readonly bin: string;
}

function readWorktreeTabs(raw: unknown): WorktreeTab[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const r = asRecord(entry);
    const [vault, task, tree, tab, socket] = [set(r.vault), set(r.task), set(r.tree), set(r.tab), set(r.socket)];
    if (vault === undefined || task === undefined || tree === undefined || tab === undefined || socket === undefined) return [];
    return [{ vault: normalizePath(vault), task, tree, name: set(r.name) ?? 'worktree', tab, socket, bin: set(r.bin) ?? 'herdr' }];
  });
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
  const clones = paths(record.clones);
  const localVaults = new Set(Array.isArray(record.localVaults) ? record.localVaults.flatMap((d) => { const p = set(d); return p === undefined ? [] : [normalizePath(p)]; }) : []);

  // The list, or the map from before it with the active vault put first.
  let vaults: Record<string, string> = {};
  if (Array.isArray(record.vaults)) {
    for (const entry of record.vaults) {
      const r = asRecord(entry);
      const [name, path] = [set(r.name), set(r.path)];
      if (name === undefined || path === undefined || vaults[name] !== undefined) continue;
      vaults[name] = normalizePath(path);
      if (r.type === 'local') localVaults.add(normalizePath(path));
    }
  } else {
    const named = paths(record.vaults);
    const first = set(record.active);
    vaults = { ...(first !== undefined && named[first] !== undefined ? { [first]: named[first] } : {}), ...named };
  }
  const active = Object.keys(vaults)[0];
  const skillDir = typeof record.skillDir === 'string' ? record.skillDir
    : Array.isArray(record.skillDir) ? record.skillDir.filter((d): d is string => typeof d === 'string') : undefined;
  const terminals = readTerminals(record.terminals);
  const worktreeTabs = readWorktreeTabs(record.worktreeTabs);
  return {
    version: typeof record.version === 'number' ? record.version : 1,
    ...(active === undefined ? {} : { active }),
    vaults,
    clones,
    ...(skillDir === undefined ? {} : { skillDir }),
    ...(localVaults.size === 0 ? {} : { localVaults: [...localVaults] }),
    ...(terminals.length === 0 ? {} : { terminals }),
    ...(worktreeTabs.length === 0 ? {} : { worktreeTabs }),
  };
}

/** The registry as the file keeps it: the vaults a list, each with its type, and no `active` beside it, which is the first. */
function asFile(config: MachineConfig): Record<string, unknown> {
  const { active: _first, vaults, localVaults = [], ...rest } = config;
  const local = new Set(localVaults.map(pathKey));
  const listed = new Set(Object.values(vaults).map(pathKey));
  const others = localVaults.filter((p) => !listed.has(pathKey(p)));
  return {
    ...rest,
    vaults: Object.entries(vaults).map(([name, path]) => ({ name, path, type: local.has(pathKey(path)) ? 'local' : 'remote' })),
    ...(others.length === 0 ? {} : { localVaults: others }),
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
  editJson(machineConfigPath(), () => asFile(edit(readMachine())));
  revision += 1;
}

/** Every vault registered here, in the list's order: the active one first. */
export function registeredVaults(): { name: string; path: string }[] {
  return Object.entries(readMachine().vaults).map(([name, path]) => ({ name, path }));
}

/** Record a vault under `name`, overwriting any path already there: first of the list, so active, or with `activate` false, last. */
export function registerVault(name: string, path: string, activate = true): void {
  editMachine((current) => {
    const { [name]: _was, ...others } = current.vaults;
    const entry = { [name]: normalizePath(path) };
    return { ...current, vaults: activate ? { ...entry, ...others } : { ...others, ...entry } };
  });
}

/** Make `name` the active vault: the first of the list, the rest keeping their order. */
export function setActiveVault(name: string): void {
  editMachine((current) => {
    const path = current.vaults[name];
    if (path === undefined) return current;
    const { [name]: _was, ...others } = current.vaults;
    return { ...current, vaults: { [name]: path, ...others } };
  });
}

/** Whether this machine keeps the vault at `dir` to itself. */
export function keptLocal(dir: string): boolean {
  const at = pathKey(dir);
  return (readMachine().localVaults ?? []).some((v) => pathKey(v) === at);
}

/** Keep the vault at `dir` to this machine, or stop keeping it so. */
export function keepLocal(dir: string, on: boolean): void {
  const at = pathKey(dir);
  editMachine((current) => {
    const others = (current.localVaults ?? []).filter((v) => pathKey(v) !== at);
    const { localVaults: _was, ...rest } = current;
    const localVaults = on ? [...others, normalizePath(dir)] : others;
    return localVaults.length === 0 ? rest : { ...rest, localVaults };
  });
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

/** Keep `held` as the tab of its task's worktree, in place of any kept before for that worktree. */
export function holdWorktreeTab(held: WorktreeTab): void {
  const vault = normalizePath(held.vault);
  editMachine((current) => ({
    ...current,
    worktreeTabs: [...(current.worktreeTabs ?? []).filter((t) => t.vault !== vault || t.task !== held.task || t.tree !== held.tree), { ...held, vault }],
  }));
}

/** Forget the tab `tab` of `task`'s worktrees, once it is closed. */
export function letWorktreeTabGo(vault: string, task: string, tab: string): void {
  const at = normalizePath(vault);
  editMachine((current) => {
    const worktreeTabs = (current.worktreeTabs ?? []).filter((t) => t.vault !== at || t.task !== task || t.tab !== tab);
    const { worktreeTabs: _was, ...rest } = current;
    return worktreeTabs.length === 0 ? rest : { ...rest, worktreeTabs };
  });
}

/** The tabs `yan serve` opened for the worktrees of the tasks of the vault at `vault`. */
export function worktreeTabsOf(vault: string): WorktreeTab[] {
  const at = normalizePath(vault);
  return (readMachine().worktreeTabs ?? []).filter((t) => t.vault === at);
}

/** The agents running in herdr panes for the tasks of the vault at `vault`, as bare `yan` kept them. */
export function terminalsOf(vault: string): HeldTerminal[] {
  const at = normalizePath(vault);
  return (readMachine().terminals ?? []).filter((t) => t.vault === at);
}
