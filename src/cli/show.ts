import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { enterLockFile, paneOfEnterLock } from './shared/enter-lock.js';
import { CommandError } from './shared/errors.js';
import { repoDirIfKnown } from './shared/repo.js';
import { isTty } from './shared/resolve.js';
import { dash } from './shared/table.js';
import { queueJson } from './ls.js';
import { WorktreePool, type LeaseRow } from '../externals/worktree/index.js';
import { Log } from '../records/log/index.js';
import { Shift } from '../records/shift/index.js';
import { Task } from '../records/task/index.js';
import { gitLines, gitOk } from '../util/git.js';
import { readJsonIfPresent } from '../util/json.js';
import { isStale, owner } from '../util/lock.js';

/**
 * `yan show [<id>] [--json]` — one task at a glance: whether a yan is running
 * on it, what it is for, each unit's branch and standing tree, its live
 * shifts, and the last log entries. Every fact is local: nothing here asks
 * the forge or the terminal, so a shift's line is the last event it reported,
 * not its state, and a merge request is the address that was recorded.
 */

/** How many log entries are shown. */
export const SHOW_LOG_TAIL = 5;

export interface ShowJson {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly complete: boolean;
  readonly dir: string;
  /** Whether a live `yan continue` holds the task, and the pane it is in. */
  readonly session: { readonly running: boolean; readonly pane: string | null };
  /** The first line of prose in brief.md. */
  readonly goal: string;
  readonly units: readonly {
    readonly name: string;
    readonly repo: string;
    readonly branch: string;
    readonly target: string;
    readonly mode: string;
    readonly mr: string | null;
    readonly scope: readonly string[];
    readonly needs: readonly string[];
    /** Commits on the branch that target lacks, by the refs last fetched; null when unknown. */
    readonly ahead: number | null;
    /** The standing tree leased to `<task>/<unit>`, and how many paths are uncommitted in it. */
    readonly tree: { readonly path: string; readonly dirty: number | null } | null;
  }[];
  readonly shifts: readonly {
    readonly sid: string;
    readonly unit: string;
    readonly branch: string;
    readonly tree: string;
    readonly scenario: string;
    readonly tier: string;
    readonly pane: string;
    /** The newest line of run/status: an event, not the shift's state. */
    readonly last_event: { readonly state: string; readonly at: string; readonly note: string } | null;
  }[];
  readonly log: { readonly lines: readonly string[]; readonly total: number };
}

function goalOf(task: Task): string {
  let text = '';
  try {
    text = readFileSync(join(task.dir, 'brief.md'), 'utf8').replace(/^﻿/, '');
  } catch {
    return '';
  }
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== '' && !l.startsWith('#') && !/^[-*]\s*$/.test(l)) ?? ''
  );
}

function sessionOf(id: string): ShowJson['session'] {
  const file = enterLockFile(id);
  let running = false;
  try {
    running = owner(file) !== undefined && !isStale(file);
  } catch {
    running = false;
  }
  return { running, pane: running ? (paneOfEnterLock(id) ?? null) : null };
}

/** `origin/<name>` when the clone has it, `<name>` when only a local ref exists, else undefined. */
function refIn(clone: string, name: string): string | undefined {
  if (gitOk(clone, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])) return `origin/${name}`;
  if (gitOk(clone, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])) return name;
  return undefined;
}

function aheadOf(clone: string | undefined, branch: string, target: string): number | null {
  if (clone === undefined || branch === '' || target === '') return null;
  const from = refIn(clone, target);
  const to = refIn(clone, branch);
  if (from === undefined || to === undefined) return null;
  const count = Number.parseInt(gitLines(clone, ['rev-list', '--count', `${from}..${to}`])[0] ?? '', 10);
  return Number.isNaN(count) ? null : count;
}

function standingTree(leases: readonly LeaseRow[], holder: string): ShowJson['units'][number]['tree'] {
  const lease = leases.find((l) => l.holder === holder);
  if (lease === undefined) return null;
  if (!existsSync(lease.path)) return { path: lease.path, dirty: null };
  if (!gitOk(lease.path, ['rev-parse', '--is-inside-work-tree'])) return { path: lease.path, dirty: null };
  return { path: lease.path, dirty: gitLines(lease.path, ['status', '--porcelain']).length };
}

function lastEvent(shift: Shift): ShowJson['shifts'][number]['last_event'] {
  let text = '';
  try {
    text = readFileSync(join(shift.run, 'status'), 'utf8');
  } catch {
    return null;
  }
  const line = text.split(/\r?\n/).filter((l) => l !== '').pop();
  if (line === undefined) return null;
  const [at = '', state = '', ...note] = line.split('\t');
  return { state, at, note: note.join('\t') };
}

export function showJson(id: string): ShowJson {
  const task = new Task(id);
  const data = task.read();
  const leasesByClone = new Map<string, readonly LeaseRow[]>();
  const leasesOf = (clone: string | undefined): readonly LeaseRow[] => {
    if (clone === undefined) return [];
    if (!leasesByClone.has(clone)) {
      try {
        leasesByClone.set(clone, new WorktreePool(clone).status());
      } catch {
        leasesByClone.set(clone, []);
      }
    }
    return leasesByClone.get(clone) ?? [];
  };

  const units = data.units.map((u) => {
    const clone = repoDirIfKnown(u.repo);
    return {
      name: u.name,
      repo: u.repo,
      branch: u.branch,
      target: u.target,
      mode: u.mode,
      mr: u.mr,
      scope: u.scope,
      needs: u.needs,
      ahead: aheadOf(clone, u.branch, u.target),
      tree: standingTree(leasesOf(clone), `${id}/${u.name}`),
    };
  });

  const shifts = Shift.liveIn(id).map((shift) => {
    const meta = shift.meta();
    const raw = readJsonIfPresent(join(shift.run, 'meta.json'));
    const extra = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    const text = (v: unknown): string => (typeof v === 'string' ? v : '');
    return {
      sid: shift.sid,
      unit: meta.unit ?? '',
      branch: meta.branch ?? '',
      tree: meta.tree ?? '',
      scenario: text(extra.scenario),
      tier: text(extra.tier),
      pane: meta.agentId ?? '',
      last_event: lastEvent(shift),
    };
  });

  return {
    version: 1,
    id: data.id,
    title: data.title,
    complete: data.complete,
    dir: task.dir,
    session: sessionOf(id),
    goal: goalOf(task),
    units,
    shifts,
    log: new Log(id).excerpt([], SHOW_LOG_TAIL),
  };
}

function ago(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function renderShow(show: ShowJson): void {
  const state = show.complete ? 'done' : 'open';
  const session = show.session.running
    ? `yan running${show.session.pane === null ? '' : ` in ${show.session.pane}`}`
    : 'no yan running';
  out(`${show.id}  ${dash(show.title)}   ${state} · ${session}`);
  if (show.goal !== '') out(`  ${show.goal}`);

  out('');
  out('── units');
  if (show.units.length === 0) out('  (none)');
  for (const u of show.units) {
    const ahead = u.ahead === null ? '' : `   ${u.ahead} ahead of ${u.target}`;
    out(`  ${u.name}  ${dash(u.branch)} → ${dash(u.target)}   ${u.mode}${ahead}`);
    if (u.scope.length > 0 || u.needs.length > 0) {
      out(`      scope ${u.scope.length > 0 ? u.scope.join(' ') : '(whole repository)'}${u.needs.length > 0 ? `   needs ${u.needs.join(' ')}` : ''}`);
    }
    if (u.mr !== null) out(`      mr    ${u.mr}`);
    const dirty = u.tree?.dirty === null || u.tree?.dirty === undefined
      ? ''
      : u.tree.dirty === 0 ? '   clean' : `   ${u.tree.dirty} uncommitted`;
    out(`      tree  ${u.tree === null ? '(no standing tree)' : `${u.tree.path}${dirty}`}`);
  }

  out('');
  out('── shifts');
  if (show.shifts.length === 0) out('  (none running)');
  for (const s of show.shifts) {
    const as = s.scenario === '' ? '' : `  ${s.scenario}${s.tier === '' ? '' : `/${s.tier}`}`;
    const event = s.last_event === null
      ? 'no event yet'
      : `last event ${s.last_event.state}${ago(s.last_event.at) === '' ? '' : ` ${ago(s.last_event.at)}`}${s.last_event.note === '' ? '' : ` — ${s.last_event.note}`}`;
    out(`  ${s.sid}  ${dash(s.unit)}${as}   ${event}`);
    out(`      tree  ${dash(s.tree)}   ${dash(s.branch)}${s.pane === '' ? '' : `   pane ${s.pane}`}`);
  }

  out('');
  out(`── log  last ${show.log.lines.length} of ${show.log.total}`);
  if (show.log.lines.length === 0) out('  (nothing logged yet)');
  for (const line of show.log.lines) out(`  ${line.replace(/^- /, '')}`);

  if (!show.complete && !show.session.running) {
    out('');
    out(`→ yan continue ${show.id}`);
  }
}

/**
 * `given`, or a task chosen from the incomplete ones when there is a terminal.
 *
 * @throws CommandError `usage` when no id was given and nothing can be chosen.
 */
async function chooseWhenMissing(given: string): Promise<string> {
  if (given !== '') return given;
  if (!isTty()) {
    throw CommandError.usage('show', "which task? pass 'yan show <id>' - choosing interactively needs a terminal, and 'yan ls' lists the tasks");
  }
  const queue = queueJson() as { tasks: { id: string; title: string; complete: boolean; units: unknown[]; shifts: number }[] };
  const live = queue.tasks.filter((t) => !t.complete);
  if (live.length === 0) throw CommandError.usage('show', "there are no tasks in progress - 'yan ls' lists the finished ones");
  const { chooseTask } = await import('../ui/prompts.js');
  return chooseTask(
    live.map((t) => ({ id: t.id, title: t.title, units: t.units.length, shifts: t.shifts })),
    'yan show',
    'Which task do you want to see?',
  );
}

/** Print one task, as `yan show` does. Shared with `yan ls <id>`. */
export function printTask(id: string, json: boolean): void {
  if (!Task.exists(id)) {
    const where = Task.isId(id) ? new Task(id).file : `${id}/task.json`;
    throw new CommandError('task', 'missing', `no such task: ${id} - ${where} does not exist`);
  }
  const show = showJson(id);
  if (json) out(JSON.stringify(show));
  else renderShow(show);
}

export const command = new Command('show')
  .description('one task at a glance: its session, branches, trees, shifts and last log entries')
  .argument('[task-id]', 'the task; with none and a terminal, choose among those in progress')
  .option('--json', 'machine readable output')
  .addHelpText(
    'after',
    `
usage: yan show [<task-id>] [--json]

Everything shown is read from this machine: no forge and no terminal is asked.
A shift's line is the last event it reported - 'yan state <sid>' says what is
true now - and "ahead" counts commits by the refs the clone last fetched.`,
  )
  .action(
    action('show', async (id: string | undefined, options: { json?: boolean }) => {
      printTask(await chooseWhenMissing(id ?? ''), options.json === true);
    }),
  );
