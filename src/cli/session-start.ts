import { existsSync, readdirSync, statSync } from 'node:fs';
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
import { yanHome } from '../util/home.js';
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

  return { version: 1, home: yanHome(), tasks };
}

function render(picture: Picture): void {
  out('yan session-start');
  out(`  home     ${picture.home}`);
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

      if (id !== '') {
        if (!Task.exists(id)) throw CommandError.usage('session_start', `no such task: ${id}`);
      }

      const picture = rebuild(id !== '' ? [id] : Task.list());
      if (options.json === true) {
        out(JSON.stringify(picture));
        return;
      }
      render(picture);
    }),
  );
