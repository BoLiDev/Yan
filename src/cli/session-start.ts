import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { dash } from './shared/table.js';
import { Terminal, type Alive } from '../externals/herdr/index.js';
import { RemoteGit, type MrRef, type MrState } from '../externals/remote-git/index.js';
import { WorktreePool, type LeaseRow } from '../externals/worktree/index.js';
import { Shift } from '../records/shift/index.js';
import { Task } from '../records/task/index.js';
import { skillsDir, vaultDir } from '../util/vault.js';
import { machineSkillsDir } from '../util/machine.js';
import { registry } from './shared/repo.js';
import { pullVault, type PullResult } from './vault.js';
import { samePath } from '../util/paths.js';

/**
 * `yan session-start` — rebuild the whole picture, and the SessionStart hook
 * for both harnesses.
 *
 *     scan tasks/  →  ask the terminal  →  ask the pool  →  ask the host
 *
 * Writes nothing, so a restart costs nothing and there is no file to disagree
 * with the world; its own test asserts `$YAN_HOME` is byte-for-byte unchanged.
 * A source that will not answer costs one fact, reported as `unknown`, and
 * never a crash.
 */

type Reported = Alive | 'n/a';
type PoolState = 'leased' | 'free' | 'unknown' | 'n/a';
type MrReport = MrState | 'none' | 'n/a';

export interface ShiftRow {
  readonly sid: string;
  readonly unit: string;
  readonly branch: string;
  readonly tree: string;
  readonly agent: string;
  readonly agent_id: string;
  readonly container: string;
  readonly live: boolean;
  readonly terminal: Reported;
  readonly pool: PoolState;
  readonly mr: string;
  readonly mr_state: MrReport;
  readonly events: number;
}

export interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly complete: boolean;
  readonly units: {
    name: string;
    repo: string;
    branch: string;
    target: string;
    mode: string;
    mr: string | null;
    scope: string[];
  }[];
  readonly shifts: ShiftRow[];
}

/**
 * A repository this context knows about. `path` is absent when nothing on this
 * machine has said where its clone is.
 */
export interface RepoRow {
  readonly name: string;
  readonly url: string;
  readonly path?: string;
}

export interface Picture {
  readonly version: 1;
  readonly home: string;
  readonly repos: RepoRow[];
  readonly tasks: TaskRow[];
}

/** The three live sources; each defaults to the real one. */
export interface Sources {
  readonly aliveOf?: (paneId: string) => Alive;
  readonly leasesOf?: (clone: string) => readonly LeaseRow[];
  readonly mrStateOf?: (ref: MrRef) => MrState;
}

function askTerminal(sources: Sources, paneId: string): Alive {
  if (paneId === '') return 'unknown';
  try {
    return (sources.aliveOf ?? ((p: string) => new Terminal().agentAlive(p)))(paneId);
  } catch {
    return 'unknown';
  }
}

function askHost(sources: Sources, mr: string, dir: string): MrReport {
  if (mr === '') return 'none';
  const ref: MrRef = dir !== '' && existsSync(dir) ? { mr, dir } : { mr };
  try {
    return (sources.mrStateOf ?? ((r: MrRef) => new RemoteGit().mrState(r)))(ref);
  } catch {
    return 'unknown';
  }
}

/**
 * Whether a tree is leased, asking each clone's pool at most once. The cache
 * is per call and never touches disk.
 */
function poolAsker(sources: Sources): (clone: string, tree: string, leaseId: string) => PoolState {
  const cache = new Map<string, readonly LeaseRow[] | undefined>();
  return (clone, tree, leaseId) => {
    if (clone === '' || !existsSync(clone)) return 'unknown';
    if (!cache.has(clone)) {
      try {
        cache.set(clone, (sources.leasesOf ?? ((c: string) => new WorktreePool(c).status()))(clone));
      } catch {
        cache.set(clone, undefined);
      }
    }
    const leases = cache.get(clone);
    if (leases === undefined) return 'unknown';
    const held = leases.some(
      (l) => (tree !== '' && samePath(l.path, tree)) || (leaseId !== '' && l.lease_id === leaseId),
    );
    return held ? 'leased' : 'free';
  };
}

function shiftIds(task: string): string[] {
  const dir = join(new Task(task).dir, 'shifts');
  try {
    return readdirSync(dir)
      .filter((sid) => Shift.isId(sid) && statSync(join(dir, sid)).isDirectory())
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

/** The clones this context knows about; `[]` when the registry cannot be read. */
function knownRepos(): RepoRow[] {
  try {
    return registry().map((r) => ({
      name: r.name,
      url: r.url,
      ...(r.path === undefined ? {} : { path: r.path }),
    }));
  } catch {
    return [];
  }
}

/**
 * The whole picture. A task that cannot be read is left out; the live sources
 * are asked only about shifts that are still live, and answer `n/a` otherwise.
 */
export function rebuild(ids: readonly string[], sources: Sources = {}): Picture {
  const askPool = poolAsker(sources);

  const tasks: TaskRow[] = [];
  for (const id of ids) {
    const record = new Task(id);
    let data;
    try {
      data = record.read();
    } catch {
      continue;
    }

    const shifts: ShiftRow[] = [];
    for (const sid of shiftIds(id)) {
      const shift = new Shift(id, sid);
      const meta = shift.meta();
      const live = shift.isLive();
      const tree = meta.tree ?? '';
      const clone = meta.clone ?? '';

      shifts.push({
        sid,
        unit: meta.unit ?? '',
        branch: meta.branch ?? '',
        tree,
        agent: meta.agent ?? '',
        agent_id: meta.agentId ?? '',
        container: meta.container ?? '',
        live,
        terminal: live ? askTerminal(sources, meta.agentId ?? '') : 'n/a',
        pool: live ? askPool(clone, tree, meta.leaseId ?? '') : 'n/a',
        mr: meta.mr ?? '',
        mr_state: live ? askHost(sources, meta.mr ?? '', tree !== '' ? tree : clone) : 'n/a',
        events: shift.eventCount(),
      });
    }

    tasks.push({
      id: data.id,
      title: data.title,
      complete: data.complete === true,
      units: data.units.map((u) => ({
        name: u.name,
        repo: u.repo,
        branch: u.branch,
        target: u.target,
        mode: u.mode,
        mr: u.mr,
        scope: u.scope,
      })),
      shifts,
    });
  }

  return { version: 1, home: vaultDir(), repos: knownRepos(), tasks };
}


export interface Skill {
  /** Relative to the directory it was found in, so it can be opened. */
  readonly path: string;
  /** From the front matter, or the file name when it declares none. */
  readonly name: string;
  /** From the front matter. Empty when it declares none. */
  readonly description: string;
}

/**
 * The `name` and `description` a skill declares in its front matter:
 *
 * ```
 * ---
 * name: Integration branches
 * description: branches come from the ticket system, not from yan
 * ---
 * ```
 *
 * Understands `key: value` on one line, optionally quoted, inside a leading
 * `---` fence, and nothing else of YAML. A file with no front matter takes
 * `fileName` as its name and an empty description.
 */
export function frontMatter(fileName: string, text: string): { name: string; description: string } {
  const lines = text.split(/\r?\n/);
  const fields: Record<string, string> = {};

  if (lines[0]?.trim() === '---') {
    for (const raw of lines.slice(1)) {
      const line = raw.trim();
      if (line === '---') break;
      const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
      if (match === null) continue;
      let value = (match[2] ?? '').trim();
      if (
        (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
        (value.startsWith("'") && value.endsWith("'") && value.length > 1)
      ) {
        value = value.slice(1, -1);
      }
      fields[(match[1] as string).toLowerCase()] = value;
    }
  }

  const name = fields.name !== undefined && fields.name !== '' ? fields.name : fileName;
  return { name, description: fields.description ?? '' };
}

/**
 * Index the `*.md` files in one skills directory — path, name and description,
 * never the text. An unreadable directory or file is skipped.
 */
function readSkillsFrom(dir: string, label: string): Skill[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  } catch {
    return [];
  }
  const found: Skill[] = [];
  for (const name of names) {
    let text: string;
    try {
      text = readFileSync(join(dir, name), 'utf8').trim();
    } catch {
      continue;
    }
    if (text === '') continue;
    found.push({ path: `${label}/${name}`, ...frontMatter(name, text) });
  }
  return found;
}

/** Every skill, the vault's before this machine's. */
export function readSkills(): Skill[] {
  let fromVault: Skill[] = [];
  try {
    fromVault = readSkillsFrom(skillsDir(), 'skills');
  } catch {
    fromVault = [];
  }
  return [...fromVault, ...readSkillsFrom(machineSkillsDir(), 'machine skills')];
}

function render(picture: Picture, pulled: PullResult): void {
  out('yan session-start');
  out(`  vault    ${picture.home}`);
  out(`  sync     ${pulled.ok ? pulled.message : `WARN ${pulled.message}`}`);
  out(`  tasks    ${picture.tasks.length}`);
  for (const repo of picture.repos) {
    out(`  repo     ${repo.name}  ${repo.path ?? `not linked on this machine - 'yan repo link ${repo.name} <path>'`}`);
  }
  if (picture.tasks.length === 0) {
    out('');
    out(`nothing to rebuild: ${picture.home}/tasks is empty`);
    return;
  }

  for (const t of picture.tasks) {
    out('');
    out(`${t.id}  ${dash(t.title)}   [${t.complete ? 'done' : 'open'}]`);
    for (const u of t.units) {
      out(`  unit ${dash(u.name)}  branch ${dash(u.branch)}  target ${dash(u.target)}  mode ${dash(u.mode)}  mr ${dash(u.mr)}`,
      );
    }
    if (t.shifts.length === 0) {
      out('  (no shift has ever been dispatched)');
    }
    for (const s of t.shifts) {
      out(
        `  shift ${s.sid}  ${dash(s.unit)}  ${dash(s.branch)}` +
          `  terminal=${s.terminal}  pool=${s.pool}  mr=${s.mr_state}` +
          `  events=${s.events}` +
          (s.live ? '' : '  (clocked out)'),
      );
    }
  }

  out('');
  out('Nothing was stored: this picture was rebuilt from the task directories,');
  out('the terminal, the pool and the forge, and it is rebuilt again next time.');

  renderSkills(readSkills());
}

/** Print the skills index: a path, a name and a sentence each. Silent when empty. */
function renderSkills(skills: readonly Skill[]): void {
  if (skills.length === 0) return;
  out('');
  out('What you may do yourself here.');
  out('');
  out('Standing instructions from `user` about this environment. Where one covers');
  out('what is being asked, read it and do the thing yourself rather than');
  out('dispatching a shift, and say which one you acted on.');
  out('');
  for (const skill of skills) {
    out(`  ${skill.path}`);
    out(`      ${skill.name}${skill.description === '' ? '' : ` — ${skill.description}`}`);
  }
}

export const command = new Command('session-start')
  .description('rebuild the picture from disk, the terminal, the pool and the forge')
  .argument('[task]')
  .option('--task <id>', 'the task to rebuild')
  .option('--all', 'every task, even when $YAN_TASK is set')
  .option('--json', 'the same facts, machine readable')
  .addHelpText(
    'after',
    `
usage: yan session-start [<task-id>] [--task <id>] [--all] [--json]

  (no id)   the task in $YAN_TASK, or every task when that is unset
  --all     every task, even when $YAN_TASK is set

A source that cannot be reached is reported as \`unknown\` rather than being
treated as an error: a fresh machine has no Herdr server yet, and a train has
no forge. Nothing is stored, which is what makes restarting yan a non-event.`,
  )
  .action(
    action('yan session-start', (positional: string | undefined, options: { task?: string; all?: boolean; json?: boolean }) => {
      if (options.all === true && positional !== undefined && positional !== '') {
        throw CommandError.usage('session_start', '--all and a task id are alternatives');
      }
      const id = options.all === true ? '' : (options.task ?? positional ?? process.env.YAN_TASK ?? '');

      // Caught up before the picture is rebuilt. Never fatal: a pull that
      // fails costs one line on stderr and the session continues on local
      // state.
      const pulled = pullVault();
      if (options.json === true && !pulled.ok) {
        process.stderr.write(`yan session-start: vault pull: ${pulled.message}\n`);
      }

      if (id !== '') {
        if (!Task.exists(id)) throw CommandError.usage('session_start', `no such task: ${id}`);
      }

      const picture = rebuild(id !== '' ? [id] : Task.list());
      if (options.json === true) {
        out(JSON.stringify(picture));
        return;
      }
      render(picture, pulled);
    }),
  );
