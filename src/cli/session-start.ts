import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { readScenarios, resolveShift, runsAs } from './shared/config.js';
import { deliverableLines, deliverableTally, NO_DELIVERABLES_NOTICE } from './shared/deliverables.js';
import { terminalWidth } from './shared/style.js';
import { dash } from './shared/table.js';
import { Terminal, type Alive } from '../externals/herdr/index.js';
import { RemoteGit, type MrRef, type MrState } from '../externals/remote-git/index.js';
import { WorktreePool, type LeaseRow } from '../externals/worktree/index.js';
import { Shift } from '../records/shift/index.js';
import { Deliverables, Task } from '../records/task/index.js';
import { Log, type LogType } from '../records/log/index.js';
import { readLearnings, readSkills, type Indexed } from '../records/memory/index.js';
import { Drafts } from '../records/drafts/index.js';
import { localStamp } from './draft.js';
import { memDir, vaultDir } from '../util/vault.js';
import { registry } from './shared/repo.js';
import { pullVault, type PullResult } from './vault.js';
import { normalizePath, samePath } from '../util/paths.js';
import { YanError } from '../util/error.js';

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

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly complete: boolean;
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

interface Picture {
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
        agent_id: meta.pane ?? '',
        container: meta.container ?? '',
        live,
        terminal: live ? askTerminal(sources, meta.pane ?? '') : 'n/a',
        pool: live ? askPool(clone, tree, meta.lease_id ?? '') : 'n/a',
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
        mr: u.mr,
        scope: u.scope,
      })),
      shifts,
    });
  }

  return { version: 1, home: vaultDir(), repos: knownRepos(), tasks };
}


/** How many of the most recent log entries a session starts with. */
export const LOG_TAIL = 20;

/** How many of the newest drafts a session starts with. */
export const DRAFTS_SHOWN = 10;

/** The log entries a session starts with in full, however old. */
const LOG_KEPT: readonly LogType[] = ['agreed', 'changed'];

function readTrimmed(file: string): string {
  try {
    return readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  } catch {
    return '';
  }
}

/**
 * `user`'s drafts: how many, and the newest by id, date and title. Their text
 * stays out, since a draft is read when it looks relevant rather than every
 * session.
 */
function renderDrafts(id: string): void {
  const drafts = new Drafts(id);
  const total = drafts.count();
  out('');
  if (total === 0) {
    out("── drafts  none yet (user writes them with 'yan draft')");
    return;
  }
  const shown = drafts.list({ limit: DRAFTS_SHOWN });
  out(`── drafts  ${shown.length < total ? `${shown.length} of ${total}` : `${total}`}  ${drafts.dir}`);
  out("user's own notes about this task, written outside this conversation. Read one");
  out("with 'yan draft cat <id>' when it looks relevant; yan never writes them.");
  out(`Past the newest ${DRAFTS_SHOWN}: 'yan draft ls --plain --limit <n>' lists more and 'yan draft`);
  out("search <words>' finds a phrase. Other tasks' drafts are plain markdown under");
  out(`${normalizePath(vaultDir())}/tasks/<id>/artifacts/drafts/ - grep there when an earlier task's note might apply.`);
  out('');
  for (const d of shown) out(`  ${d.id}  ${localStamp(d.updated)}  ${d.title}`);
}

/**
 * What the task has to build, and the notice that comes instead when nobody
 * has said yet. A file that does not validate is reported here and stops
 * nothing: the rest of the picture is still worth having.
 */
function renderDeliverables(id: string, complete: boolean): void {
  const record = new Deliverables(id);
  const { deliverables, problem } = record.readOrNone();

  out('');
  if (problem !== null) {
    out('── deliverables  UNREADABLE');
    out(problem);
    out("Nothing was changed. Fix the file by hand, or 'yan deliverable' will refuse too.");
    return;
  }
  if (deliverables.length === 0) {
    if (complete) {
      out(`── deliverables  none recorded  ${record.file}`);
      return;
    }
    out(`── deliverables  none yet  ${record.file}`);
    for (const line of NO_DELIVERABLES_NOTICE) out(line);
    return;
  }
  out(`── deliverables  ${deliverableTally(deliverables)}  ${record.file}`);
  out('What this task has to build to solve the problems the brief states. Written');
  out("only by 'yan deliverable'; log.md says how they moved, this says what they are.");
  out('');
  for (const line of deliverableLines(deliverables, {}, terminalWidth())) out(line);
}

/**
 * What the task has remembered: its brief, what it has to build, the log
 * entries that still bind, the learnings index and `mem/user.md`. Printed
 * for one task only.
 */
function renderMemory(id: string, complete: boolean): void {
  const record = new Task(id);

  out('');
  out(`── brief  ${normalizePath(join(record.dir, 'brief.md'))}`);
  out('The background and the problems this task is there to solve.');
  out('');
  out(readTrimmed(join(record.dir, 'brief.md')) || '(empty)');

  renderDeliverables(id, complete);
  renderDrafts(id);

  const log = new Log(id).excerpt(LOG_KEPT, LOG_TAIL);
  out('');
  out(`── log  ${log.lines.length < log.total ? `${log.lines.length} of ${log.total} entries` : `${log.total} entries`}  ${new Log(id).file}`);
  out(`Every agreed and changed entry, and the last ${LOG_TAIL} of any kind. An agreed`);
  out('entry is what was understood then, not a verdict for ever: a later one');
  out('overrides it, and an option dropped before can be raised again if you say it');
  out('was dropped before, and why.');
  out('');
  for (const line of log.lines.length > 0 ? log.lines : ['(nothing logged yet)']) out(line);

  const learnings = readLearnings();
  if (learnings.length > 0) {
    out('');
    out('── learnings');
    out('What earlier work found out the hard way. Open the one that matches before');
    out('working a problem out again.');
    out('');
    for (const l of learnings) {
      out(`  ${l.path}`);
      out(`      ${l.name}${l.description === '' ? '' : ` — ${l.description}`}`);
    }
  }

  let user = '';
  try {
    user = readTrimmed(join(memDir(), 'user.md'));
  } catch {
    user = '';
  }
  if (user !== '') {
    out('');
    out('── user  mem/user.md');
    out('');
    out(user);
  }
}

function render(picture: Picture, pulled: PullResult, memoryOf?: string): void {
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
          `  events=${s.events}` +
          (s.live ? '' : '  (clocked out)'),
      );
    }
  }

  out('');
  out('Nothing was stored: this picture was rebuilt from the task directories,');
  out('the terminal, the pool and the forge, and it is rebuilt again next time.');

  if (memoryOf !== undefined) {
    renderMemory(memoryOf, picture.tasks.find((t) => t.id === memoryOf)?.complete === true);
  }
  renderScenarios();
  renderSkills(readSkills());
}

/**
 * What a shift can be dispatched as: each scenario, its tiers, and what each
 * tier really runs. Problems in the configuration are printed rather than
 * hidden, because a dispatch will refuse over them.
 */
function renderScenarios(): void {
  const { scenarios, problems } = readScenarios();
  out('');
  out('── scenarios');
  out('What a shift can be dispatched as: yan shift new --scenario <s> [--tier <t>].');
  out("Choose the scenario by the kind of work and the tier by its description; the");
  out("scenario's default when unsure. Only these exist - there is no other model to ask for.");
  out('');
  for (const scenario of scenarios) {
    out(`  ${scenario.name} — ${scenario.description}`);
    for (const tier of scenario.tiers) {
      const spec = resolveShift('session_start', scenario.name, tier.name);
      const runs = runsAs(spec);
      const mark = tier.name === scenario.defaultTier ? ' (default)' : '';
      out(`      ${tier.name}${mark}  ${runs}${tier.description === '' ? '' : ` — ${tier.description}`}`);
    }
  }
  for (const problem of problems) out(`  WARN ${problem}`);
}

/** Print the skills index: a path, a name and a sentence each. Silent when empty. */
function renderSkills(skills: readonly Indexed[]): void {
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
  .argument('[task-id]', 'the task; defaults to $YAN_TASK, and to every task when that is unset')
  .option('--all', 'every task, even when $YAN_TASK is set')
  .option('--json', 'the same facts, machine readable')
  .addHelpText(
    'after',
    `
  (no id)   the task in $YAN_TASK, or every task when that is unset
  --all     every task, even when $YAN_TASK is set

For one task it also prints what the task remembers: brief.md, the newest
${DRAFTS_SHOWN} of user's drafts, every agreed and changed entry in log.md with
the last ${LOG_TAIL} of any kind, the index of mem/learnings/, and mem/user.md.

A source that cannot be reached is reported as \`unknown\` rather than being
treated as an error: a fresh machine has no Herdr server yet, and a train has
no forge. Nothing is stored, which is what makes restarting yan a non-event.`,
  )
  .action(
    action('yan session-start', (positional: string | undefined, options: { all?: boolean; json?: boolean }) => {
      if (options.all === true && positional !== undefined && positional !== '') {
        throw YanError.usage('session_start_usage', '--all and a task id are alternatives');
      }
      const id = options.all === true ? '' : (positional ?? process.env.YAN_TASK ?? '');

      // Registered as the SessionStart hook, so a shift working on this
      // repository fires it too and would start with the main agent's whole
      // picture in its context. `YAN_SID` is set in a shift's environment and
      // never in the main agent's. `--json` is a caller asking on purpose.
      const sid = process.env.YAN_SID ?? '';
      if (sid !== '' && options.json !== true) {
        out(`shift ${sid} of task ${id === '' ? '(unknown)' : id}: the task picture belongs to the main agent, not to you - your brief is your work order.`);
        return;
      }

      // Caught up before the picture is rebuilt. Never fatal: a pull that
      // fails costs one line on stderr and the session continues on local
      // state.
      const pulled = pullVault();
      if (options.json === true && !pulled.ok) {
        process.stderr.write(`yan session-start: vault pull: ${pulled.message}\n`);
      }

      if (id !== '') {
        if (!Task.exists(id)) throw YanError.usage('session_start_usage', `no such task: ${id}`);
      }

      const picture = rebuild(id !== '' ? [id] : Task.list());
      if (options.json === true) {
        out(JSON.stringify(picture));
        return;
      }
      render(picture, pulled, id !== '' ? id : undefined);
    }),
  );
