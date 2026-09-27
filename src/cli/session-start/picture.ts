import { existsSync } from 'node:fs';
import { isMainAgentOf } from '../shared/caller.js';
import { out } from '../shared/action.js';
import { dash } from '../shared/table.js';
import { Terminal, type Alive } from '../../externals/herdr/index.js';
import { RemoteGit, type MrRef, type MrState } from '../../externals/remote-git/index.js';
import type { LeaseRow } from '../../externals/worktree/index.js';
import { Shift, clearUndelivered } from '../../records/shift/index.js';
import { Task } from '../../records/task/index.js';
import { vaultDir } from '../../util/vault.js';
import { registry } from '../shared/repo.js';
import type { PullResult } from '../shared/vault-pull.js';
import { samePath } from '../../util/paths.js';
import { poolLeases } from '../shared/leases.js';
import { stateOf, type TaskState } from '../overview/overview.js';
import { shiftFacts, type ShiftFacts } from '../overview/shift-facts.js';

/**
 * The picture half of `yan session-start`: every task, each live shift's
 * terminal, pool lease and merge request, and the reports nobody heard.
 *
 *     scan tasks/  →  ask the terminal  →  ask the pool  →  ask the host
 *
 * A source that will not answer costs one fact, reported as `unknown`, and
 * never a crash.
 */

type Reported = Alive | 'n/a';
type PoolState = 'leased' | 'free' | 'unknown' | 'n/a';
type MrReport = MrState | 'none' | 'n/a';

/**
 * A shift's own facts, and what the live sources say about a live one. This
 * task's own main agent clears `undelivered` by reading it.
 */
interface ShiftRow extends ShiftFacts {
  readonly terminal: Reported;
  readonly pool: PoolState;
  readonly mr_state: MrReport;
}

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly state: TaskState;
  readonly units: {
    name: string;
    repo: string;
    branch: string;
    target: string;
    mr: string | null;
    scope: string[];
  }[];
  readonly shifts: ShiftRow[];
}

/**
 * A repository this context knows about. `path` is absent when nothing on this
 * machine has said where its clone is.
 */
interface RepoRow {
  readonly name: string;
  readonly url: string;
  readonly path?: string;
}

export interface Picture {
  readonly version: 2;
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
  const leasesOf = poolLeases(sources.leasesOf);
  return (clone, tree, leaseId) => {
    if (clone === '' || !existsSync(clone)) return 'unknown';
    const leases = leasesOf(clone);
    if (leases === undefined) return 'unknown';
    const held = leases.some(
      (l) => (tree !== '' && samePath(l.path, tree)) || (leaseId !== '' && l.lease_id === leaseId),
    );
    return held ? 'leased' : 'free';
  };
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
    for (const shift of Shift.allIn(id)) {
      const meta = shift.meta();
      const facts = shiftFacts(shift, meta);
      const { live, tree } = facts;
      const clone = meta.clone ?? '';

      shifts.push({
        ...facts,
        terminal: live ? askTerminal(sources, facts.pane) : 'n/a',
        pool: live ? askPool(clone, tree, meta.lease_id ?? '') : 'n/a',
        mr_state: live ? askHost(sources, facts.mr, tree !== '' ? tree : clone) : 'n/a',
      });
    }

    tasks.push({
      id: data.id,
      title: data.title,
      state: stateOf(data),
      units: data.units.map((u) => ({
        name: u.name,
        repo: u.repo,
        branch: u.branch,
        target: u.target,
        mr: u.mr,
        scope: u.scope,
      })),
      shifts,
    });
  }

  return { version: 2, home: vaultDir(), repos: knownRepos(), tasks };
}

/**
 * The picture as text, ending with the undelivered reports. False when there
 * is no task to show, which is where the session's output ends.
 */
export function render(picture: Picture, pulled: PullResult): boolean {
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
    return false;
  }

  for (const t of picture.tasks) {
    out('');
    out(`${t.id}  ${dash(t.title)}   [${t.state}]`);
    for (const u of t.units) {
      out(`  unit ${dash(u.name)}  branch ${dash(u.branch)}  target ${dash(u.target)}  mr ${dash(u.mr)}`,
      );
    }
    if (t.shifts.length === 0) {
      out('  (no shift has ever been dispatched)');
    }
    for (const s of t.shifts) {
      out(
        `  shift ${s.sid}  ${dash(s.unit)}  ${dash(s.branch)}` +
          `  terminal=${s.terminal}  pool=${s.pool}  mr=${s.mr_state}` +
          `  last=${s.last_event === null ? 'none' : `${dash(s.last_event.state)}@${dash(s.last_event.at)}`}` +
          (s.live ? '' : '  (clocked out)'),
      );
    }
  }

  out('');
  out('Nothing was stored: this picture was rebuilt from the task directories,');
  out('the terminal, the pool and the forge, and it is rebuilt again next time.');

  renderUndelivered(picture);
  return true;
}

/**
 * The reports a shift made while nothing could hear them: you were in a
 * dialog, or no yan was running. Each is what the shift would have said in
 * the conversation, so read them as if they had arrived, oldest first.
 * Silent when there are none.
 */
function renderUndelivered(picture: Picture): void {
  const missed = picture.tasks.flatMap((t) =>
    t.shifts.filter((s) => s.undelivered.length > 0).map((s) => ({ task: t.id, shift: s })),
  );
  if (missed.length === 0) return;

  out('');
  out('── undelivered reports');
  out('What a shift reported while nothing was there to hear it. Each line is the');
  out('shift speaking to you; act on it as you would on one that arrived, and run');
  out("'yan state <sid>' before you do, since nobody has been watching. Reading");
  out('them clears the ones belonging to your own task, so those are said once;');
  out("another task's are left for its own yan, and you will see them again.");
  out('');
  for (const { task, shift } of missed) {
    for (const u of shift.undelivered) {
      out(`  ${task}  ${shift.sid}  ${u.state}  ${u.at === '' ? '(no time)' : u.at}  ${u.note}`);
    }
  }
}

/**
 * Forget what has been printed — for this task only. Read first, cleared
 * second: see the record.
 *
 * `--all`, and a bare `session-start` on a machine with several tasks, print
 * every task's lines, and the yan of t133 starting up must not consume the
 * reports the yan of t134 has not seen. So the test is per task, and it is
 * the same one `yan show` applies: this caller is that task's main agent.
 */
export function clearSurfaced(picture: Picture): void {
  for (const t of picture.tasks) {
    if (!isMainAgentOf(t.id)) continue;
    for (const s of t.shifts) {
      if (s.undelivered.length > 0) clearUndelivered(new Shift(t.id, s.sid).run);
    }
  }
}
