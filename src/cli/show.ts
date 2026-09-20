import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { enterLockFile, paneOfEnterLock } from './shared/enter-lock.js';
import { deliverableLines, deliverableTally } from './shared/deliverables.js';
import { repoDirIfKnown } from './shared/repo.js';
import { chosenTask } from './shared/task-id.js';
import { blue, bold, cyan, dim, fit, gray, green, magenta, red, terminalWidth, tildePath, yellow } from './shared/style.js';
import { dash } from './shared/table.js';
import { overviewTask, type OverviewTask } from './overview/overview.js';
import { renderHeader } from './overview/render.js';
import { ago } from './overview/time.js';
import { isoMoment } from './overview/when.js';
import { WorktreePool, type LeaseRow } from '../externals/worktree/index.js';
import { Log } from '../records/log/index.js';
import { Shift } from '../records/shift/index.js';
import { Deliverables, Task, type Deliverable } from '../records/task/index.js';
import { gitLines, gitOk } from '../util/git.js';
import { isStale, owner } from '../util/lock.js';
import { YanError } from '../util/error.js';

/**
 * `yan show [<id>] [--json]` — one task at a glance: whether a yan is running
 * on it, each unit's branch and standing tree, its live shifts, and the last
 * log entries. Every fact is local: nothing here asks the forge, so a
 * shift's line is the last event it reported, not its state, and a merge
 * request is the address that was recorded. The header is the task's card
 * from `yan ls`, whose age of "last active" asks Herdr once for the agents'
 * sessions, as `yan ls` does.
 */

/** How many log entries are shown. */
export const SHOW_LOG_TAIL = 5;

export interface ShowJson {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly complete: boolean;
  readonly abandoned: boolean;
  readonly dir: string;
  /** Whether a live `yan continue` holds the task, and the pane it is in. */
  readonly session: { readonly running: boolean; readonly pane: string | null };
  /** What the task has to build; empty when it has never been broken down. */
  readonly deliverables: readonly Deliverable[];
  /** What is wrong with deliverable.json, when it does not validate; null otherwise. */
  readonly deliverables_problem: string | null;
  readonly units: readonly {
    readonly name: string;
    readonly repo: string;
    readonly branch: string;
    readonly target: string;
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
    /** The task is done and this shift never clocked out: its run/ is left over, not running. */
    readonly leftover: boolean;
    /** Reported done on an open task: its work is merged or delivered, and waits to be tried and accepted. */
    readonly awaiting_acceptance: boolean;
  }[];
  readonly log: { readonly lines: readonly string[]; readonly total: number };
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
      mr: u.mr,
      scope: u.scope,
      needs: u.needs,
      ahead: aheadOf(clone, u.branch, u.target),
      tree: standingTree(leasesOf(clone), `${id}/${u.name}`),
    };
  });

  const shifts = Shift.liveIn(id).map((shift) => {
    const meta = shift.meta();
    return {
      sid: shift.sid,
      unit: meta.unit ?? '',
      branch: meta.branch ?? '',
      tree: meta.tree ?? '',
      scenario: meta.scenario,
      tier: meta.tier ?? '',
      pane: meta.pane ?? '',
      last_event: lastEvent(shift),
      leftover: data.complete,
      awaiting_acceptance: !data.complete && lastEvent(shift)?.state === 'done',
    };
  });

  const said = new Deliverables(id).readOrNone();

  return {
    version: 1,
    id: data.id,
    title: data.title,
    complete: data.complete,
    abandoned: data.abandoned,
    dir: task.dir,
    session: sessionOf(id),
    deliverables: said.deliverables,
    deliverables_problem: said.problem,
    units,
    shifts,
    log: new Log(id).excerpt([], SHOW_LOG_TAIL),
  };
}

/** How an event a shift reported is coloured: what needs somebody is loud. */
function paintEvent(state: string): string {
  if (['blocked', 'needs-decision', 'conflict'].includes(state)) return bold(yellow(state));
  if (state === 'done') return green(state);
  return blue(state);
}

const LOG_COLOURS: Record<string, (s: string) => string> = {
  agreed: magenta,
  started: blue,
  delivered: green,
  changed: yellow,
  incident: red,
  paused: gray,
};

/** One log.md entry as a row: the date dim, the type in its colour. */
function logRow(line: string, width?: number): string {
  const text = (s: string): string => (width === undefined ? s : fit(s, width));
  const typed = /^- (\d{2}-\d{2}) {2}(\S+)\s+(.*)$/.exec(line);
  if (typed !== null && LOG_COLOURS[typed[2] as string] !== undefined) {
    const [, date, type, body] = typed as unknown as [string, string, string, string];
    return `${dim(date)}  ${(LOG_COLOURS[type] as (s: string) => string)(type.padEnd(9))}  ${text(body)}`;
  }
  // Written before entries carried a type, and by hand before they carried a
  // date: named `legacy` rather than left blank, and a missing date is `--`.
  const legacy = gray('legacy'.padEnd(9));
  const untyped = /^- (\d{2}-\d{2}) {2}(.*)$/.exec(line);
  if (untyped !== null) return `${dim(untyped[1] as string)}  ${legacy}  ${text(untyped[2] as string)}`;
  return `${dim('--'.padEnd(5))}  ${legacy}  ${text(line.replace(/^- /, ''))}`;
}

/** A deliverable's status word, coloured as `yan ls` colours a task's state. */
function statusPaint(word: string): string {
  if (word.startsWith('done')) return green(word);
  if (word.startsWith('abandoned')) return red(word);
  return cyan(word);
}

function section(label: string, aside = ''): void {
  out('');
  out(` ${bold(label)}${aside === '' ? '' : `  ${dim(aside)}`}`);
}

/**
 * The task as `yan ls` shows it, with its state, its whole description and
 * everything below. The pane a yan runs in is for the main agent, in --json;
 * a person reads the task, not an address.
 */
export function renderShow(show: ShowJson, task: OverviewTask, now = new Date()): void {
  for (const line of renderHeader(task, show.session, { now, cols: terminalWidth() })) out(line);

  section(
    'Deliverables',
    show.deliverables.length === 0 ? '' : deliverableTally(show.deliverables),
  );
  if (show.deliverables_problem !== null) {
    out(`   ${yellow(show.deliverables_problem)}`);
  } else if (show.deliverables.length === 0) {
    // One quiet line. What to do about it is session start's to say, to the
    // main agent; this is `user` at a terminal looking at a task.
    out(`   ${dim(show.complete ? 'none recorded' : 'none yet - yan deliverable add "<text>"')}`);
  } else {
    for (const line of deliverableLines(show.deliverables, { id: bold, status: statusPaint, aside: dim })) {
      out(` ${line}`);
    }
  }

  section('Units');
  if (show.units.length === 0) out(`   ${dim('none')}`);
  const nameWidth = Math.max(0, ...show.units.map((u) => u.name.length));
  const indent = ' '.repeat(nameWidth + 5);
  for (const u of show.units) {
    const ahead = u.ahead === null ? '' : `   ${u.ahead === 0 ? dim('↑0') : green(`↑${u.ahead}`)}`;
    out(`   ${bold(u.name.padEnd(nameWidth))}  ${cyan(dash(u.branch))} ${dim('→')} ${dash(u.target)}${ahead}`);
    if (u.scope.length > 0 || u.needs.length > 0) {
      const needs = u.needs.length > 0 ? `   ${dim('needs')} ${u.needs.join(' ')}` : '';
      out(`${indent}${dim('scope')}  ${u.scope.length > 0 ? u.scope.join(' ') : dim('whole repository')}${needs}`);
    }
    if (u.mr !== null) out(`${indent}${dim('mr   ')}  ${u.mr}`);
    if (u.tree === null) {
      out(`${indent}${dim('tree ')}  ${dim('no standing tree')}`);
    } else {
      const dirty = u.tree.dirty === null
        ? ''
        : u.tree.dirty === 0 ? `   ${green('✓ clean')}` : `   ${yellow(`● ${u.tree.dirty} uncommitted`)}`;
      out(`${indent}${dim('tree ')}  ${tildePath(u.tree.path)}${dirty}`);
    }
  }

  const leftovers = show.shifts.filter((s) => s.leftover).length;
  const awaiting = show.shifts.filter((s) => s.awaiting_acceptance).length;
  const running = show.shifts.length - leftovers - awaiting;
  section(
    'Shifts',
    show.shifts.length === 0
      ? ''
      : [
          running > 0 ? `${running} running` : '',
          awaiting > 0 ? `${awaiting} awaiting acceptance` : '',
          leftovers > 0 ? `${leftovers} not clocked out` : '',
          'last reported events',
        ]
          .filter((x) => x !== '')
          .join(' · '),
  );
  if (show.shifts.length === 0) out(`   ${dim('none running')}`);
  const sidWidth = Math.max(0, ...show.shifts.map((s) => s.sid.length));
  const asWidth = Math.max(0, ...show.shifts.map((s) => `${s.scenario}/${s.tier}`.length));
  const eventWidth = Math.max(0, ...show.shifts.map((s) => (s.last_event?.state ?? 'no event').length));
  for (const s of show.shifts) {
    const as = s.scenario === '' ? '' : `${s.scenario}${s.tier === '' ? '' : `/${s.tier}`}`;
    const event = s.last_event?.state ?? 'no event';
    const at = s.last_event === null ? undefined : isoMoment(s.last_event.at, 'status');
    const when = at === undefined ? '' : ago(at, now);
    // The note is left to --json and `yan state`: a shift's report can run
    // to a paragraph, and this is one row per shift.
    // A done task's shift with run/ still there is debris to clean up, and
    // saying where it ran would read as if it still were.
    const place = dim([s.pane, s.branch].filter((x) => x !== '').join(' · '));
    const where = s.leftover
      ? yellow('not clocked out')
      : s.awaiting_acceptance ? `${cyan('awaiting acceptance')}   ${place}` : place;
    out(
      `   ${bold(s.sid.padEnd(sidWidth))}  ${magenta(as.padEnd(asWidth))}  ` +
        `${s.last_event === null ? dim(event.padEnd(eventWidth)) : paintEvent(event) + ' '.repeat(eventWidth - event.length)}  ` +
        `${dim(when.padStart(7))}${where === '' ? '' : `   ${where}`}`,
    );
  }

  section('Log', show.log.total === 0 ? '' : `last ${show.log.lines.length} of ${show.log.total}`);
  if (show.log.lines.length === 0) out(`   ${dim('nothing logged yet')}`);
  // Indent, date, type and their gaps come to 21 columns before the text.
  const textWidth = terminalWidth();
  for (const line of show.log.lines) {
    out(`   ${logRow(line, textWidth === undefined ? undefined : Math.max(20, textWidth - 21 - 1))}`);
  }
  out('');
}

/** Print one task. */
export function printTask(id: string, json: boolean): void {
  if (!Task.exists(id)) {
    const where = Task.isId(id) ? new Task(id).file : `${id}/task.json`;
    throw new YanError('task_missing', `no such task: ${id} - ${where} does not exist`);
  }
  const show = showJson(id);
  if (json) out(JSON.stringify(show));
  else {
    const now = new Date();
    renderShow(show, overviewTask(id, { now }), now);
  }
}

export const command = new Command('show')
  .description('one task at a glance: its session, branches, trees, shifts and last log entries')
  .argument('[task-id]', 'the task; defaults to $YAN_TASK, or asks when there is a terminal')
  .option('--json', 'machine readable output')
  .addHelpText(
    'after',
    `
Everything shown is read from this machine: no forge is asked. A shift's
line is the last event it reported - 'yan state <sid>' says what is true now -
and "ahead" counts commits by the refs the clone last fetched.`,
  )
  .action(
    action('show', async (id: string | undefined, options: { json?: boolean }) => {
      const task = await chosenTask('show', id, {
        spelled: 'yan show',
        question: 'Which task do you want to see?',
      });
      printTask(task, options.json === true);
    }),
  );
