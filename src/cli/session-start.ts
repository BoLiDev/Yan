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
import { pullVault, type PullResult } from './vault.js';
import { samePath } from '../util/paths.js';

/**
 * `yan session-start` — the full rebuild (agents.md §5.1). Registered as the
 * SessionStart hook for both harnesses.
 *
 * ---------------------------------------------------------------------------
 * A RESTART IS A NON-EVENT, AND THIS COMMAND IS WHY
 * ---------------------------------------------------------------------------
 *
 * yan holds no persistent running state. Every time it starts it rebuilds its
 * picture from scratch:
 *
 *     scan tasks/  →  ask the terminal  →  ask the pool  →  ask the host
 *
 * Whatever those say is the answer. That is what makes "close it and open a new
 * one" cost nothing: there is nothing to hand over and nothing to resume, and
 * therefore nothing that can drift out of sync.
 *
 * SO THIS COMMAND WRITES NOTHING. Not a session file, not a cache of what it
 * found, not a "last seen" timestamp. The moment it writes one, a restart stops
 * being a non-event, because there is now a file that can disagree with the
 * world. Its own test asserts that `$YAN_HOME` is byte-for-byte unchanged after
 * it runs.
 *
 * IT ALSO NEVER CRASHES ON A SOURCE THAT WILL NOT ANSWER. There is no Herdr
 * server yet on a fresh boot; the pool root may be on a disk that is not
 * mounted; the host may be unreachable on a train. Each of those costs one fact
 * and is reported as `unknown`, exactly as `yan state` and the modules
 * themselves do: where we cannot tell, we say so, and we never round a guess up
 * to a fact.
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

export interface Picture {
  readonly version: 1;
  readonly home: string;
  readonly tasks: TaskRow[];
}

/** The three live sources, each replaceable so a test can take one away. */
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
 * The pool is asked once per clone and the answer is remembered for the length
 * of ONE command — a local map, never a file. Caching it on disk is exactly the
 * thing this command may not do.
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

/** The whole picture, without the process around it. */
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
        // run/ gone means the shift clocked out, and every live source is about
        // something that no longer exists. Asking would be noise.
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

  return { version: 1, home: vaultDir(), tasks };
}


export interface Skill {
  /** Where it came from, for yan to cite when it acts on one. */
  readonly source: string;
  readonly text: string;
}

/**
 * The standing instructions for this environment (v3 td vault.md).
 *
 * A skill is PROSE, not an executable. `<vault>/skills/*.md` says what yan may
 * do itself here — check a build, run a script, look something up — instead of
 * dispatching a shift for it, and `~/.yan/skills/*.md` says the same for things
 * that are about this box rather than this context.
 *
 * They are read HERE because session-start is the SessionStart hook for both
 * harnesses: what it prints is what the main agent starts the session knowing.
 * There is no `yan skill run`, no lease, no argv contract — the machinery for
 * running one would be larger than the thing it runs.
 *
 * WHY THIS DOES NOT WEAKEN THE AUTHORITY TABLE. The table's right-hand column
 * is "only when `user` asks". A skill IS `user` asking — in advance, in
 * writing, in a file only they can put there. What it cannot do is make yan
 * forget to say what it did: acting on a skill means naming it.
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
    if (text !== '') found.push({ source: `${label}/${name}`, text });
  }
  return found;
}

export function readSkills(): Skill[] {
  // The vault first: what yan may do is normally a property of the context,
  // and a machine-level file is the remainder rather than the norm.
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

/**
 * The skills, verbatim, at the END of the rebuild.
 *
 * Last on purpose. The picture above is facts about right now; this is
 * standing instruction, and it is the part that should still be in view when
 * the session gets going.
 */
function renderSkills(skills: readonly Skill[]): void {
  if (skills.length === 0) return;
  out('');
  out('--- what you may do yourself here -----------------------------------------');
  out('');
  out("Standing instructions from `user`, in their own words. They are the opt-in:");
  out('where one of these covers what is being asked, do it yourself rather than');
  out('dispatching a shift — and say which one you are acting on.');
  for (const skill of skills) {
    out('');
    out(`## ${skill.source}`);
    out('');
    out(skill.text);
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

      // The vault is caught up BEFORE the picture is rebuilt, so a session that
      // starts on the laptop starts with the desktop's work in it (vault.md §5).
      //
      // Never fatal, and `--json` stays machine readable: a missing network, a
      // dirty vault or a conflict costs one warning line on stderr and the
      // session continues on local state. A session-start that refused because a
      // remote was unreachable would be a worse tool than one that never synced.
      const pulled = pullVault();
      if (options.json === true && !pulled.ok) {
        // `--json` stays machine readable: the warning goes to stderr, which
        // nothing parses, and the exit code is unchanged.
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
