import { bold, cells, cyan, dim, fit, green, padEnd, padStart, red, yellow } from '../shared/style.js';
import type { Overview, OverviewTask } from './overview.js';
import { age, ageTier, ago, stamp, stampParts, yearOf, type AgeTier } from './time.js';
import { isBullet, unwrapParagraph } from './description.js';
import { momentMs, type Moment } from './when.js';
import { clamp, lineText, wrap } from './wrap.js';

/**
 * The print of `yan ls` and the header of `yan show`, from the overview and
 * nothing else: pure, so a test hands it the data, a clock and a width. The
 * rules are the design's (task t128, artifacts/uix/design.md); where they and
 * its mock differ, this follows the mock, which is what was accepted.
 *
 *   ␣t131␣␣overview for yan ls                              title, bold cyan
 *   ␣2m␣␣␣␣`user` wants one command that shows what they…   description, ≤ 3 lines
 *   ␣␣␣␣␣␣␣opened 09-18 14:02 · changed 5m ago             meta, dim
 *
 * Open tasks are cards like the one above, done tasks one ledger line each.
 * Every width is in cells, and no line ends in spaces.
 */

const PIPE_WIDTH = 80; // no terminal to ask: a paragraph still has to wrap somewhere
const MAX_WIDTH = 96; // past this a paragraph stops being readable; the rest stays empty
const MIN_WIDTH = 32; // below this, lay out at 32 and let the terminal wrap
const NARROW = 60; // below this, a ledger row keeps its closing date and drops the rest
const CLAMP = 3; // lines of description on a card
const MARGIN = 1; // columns kept free on both sides
const GAP = 2; // between the id and what follows it
const SEP = ' · ';

export interface RenderOptions {
  readonly now: Date;
  /** The terminal's width; undefined for a pipe. */
  readonly cols: number | undefined;
}

interface Geometry {
  readonly now: Date;
  readonly idWidth: number;
  /** Where the title, description and meta start. */
  readonly hang: number;
  /** One past the last column written. */
  readonly right: number;
  readonly narrow: boolean;
}

function geometry(ids: readonly string[], opts: RenderOptions): Geometry {
  const width = Math.max(MIN_WIDTH, Math.min(opts.cols ?? PIPE_WIDTH, MAX_WIDTH));
  const idWidth = Math.max(4, ...ids.map(cells));
  return { now: opts.now, idWidth, hang: MARGIN + idWidth + GAP, right: width - MARGIN, narrow: width < NARROW };
}

const spaces = (n: number): string => ' '.repeat(Math.max(0, n));

const TIER_PAINT: Record<AgeTier, (s: string) => string> = {
  fresh: green,
  plain: (s) => s,
  quiet: dim,
  stale: yellow,
};

/** The id column of a card's second line: the age of "last active", or blanks when unknown. */
function ageColumn(t: OverviewTask, g: Geometry): string {
  if (t.active === null) return spaces(g.hang);
  const text = age(t.active, g.now);
  return `${spaces(MARGIN)}${TIER_PAINT[ageTier(t.active, g.now)](text)}${spaces(g.hang - MARGIN - cells(text))}`;
}

function titleLine(t: OverviewTask, g: Geometry): string {
  const title = fit(t.title === '' ? '-' : t.title, g.right - g.hang);
  return `${spaces(MARGIN)}${padEnd(t.id, g.idWidth)}${spaces(GAP)}${bold(cyan(title))}`;
}

interface Item {
  readonly plain: string;
  readonly painted: string;
}

const item = (plain: string, paint: (s: string) => string): Item => ({ plain, painted: paint(plain) });
const dimItem = (plain: string): Item => item(plain, dim);

/**
 * `opened`, `closed` when there is one, and `changed`, which has three cases
 * kept apart: a time; nothing to report, which leaves the item out; and code
 * that cannot be read here, `changed unknown`.
 */
function metaItems(t: OverviewTask, g: Geometry): Item[] {
  const items: Item[] = [];
  if (t.opened !== null) items.push(dimItem(`opened ${stamp(t.opened, g.now)}`));
  if (t.closed !== null) items.push(dimItem(`closed ${stamp(t.closed, g.now)}`));
  if (t.changed?.state === 'known') items.push(dimItem(`changed ${ago(t.changed.at, g.now)}`));
  else if (t.changed?.state === 'unknown') items.push(dimItem('changed unknown'));
  return items;
}

/** Items joined by ` · ` at `hang`, broken between items and never inside one. */
function flow(items: readonly Item[], g: Geometry): string[] {
  const room = g.right - g.hang;
  const lines: string[] = [];
  let plain = '';
  let painted = '';
  for (const next of items) {
    if (plain !== '' && cells(plain) + cells(SEP) + cells(next.plain) > room) {
      lines.push(painted);
      plain = '';
      painted = '';
    }
    painted += (plain === '' ? '' : dim(SEP)) + next.painted;
    plain += (plain === '' ? '' : SEP) + next.plain;
  }
  if (plain !== '') lines.push(painted);
  return lines.map((l) => spaces(g.hang) + l);
}

/**
 * The description's blocks. `briefDescription` has already unwrapped each one
 * onto a line of its own — a paragraph, or a bullet — so a newline is a
 * break here whether or not a blank line went with it.
 */
function paragraphs(t: OverviewTask): string[] {
  if (t.description === null) return [];
  return t.description
    .split(/\n+/)
    .map(unwrapParagraph)
    .filter((p) => p !== '');
}

/** Title line; the first paragraph clamped, the age in the id column of its first line; the meta. */
function card(t: OverviewTask, g: Geometry): string[] {
  const measure = g.right - g.hang;
  const paras = paragraphs(t);
  const body = paras.length === 0
    ? [dim('no description in brief.md')]
    : clamp(wrap(paras[0] as string, measure), CLAMP, measure, paras.length > 1);
  const lines = body.map((l, i) => (i === 0 ? ageColumn(t, g) : spaces(g.hang)) + l);
  return [titleLine(t, g), ...lines, ...flow(metaItems(t, g), g)];
}

/**
 * One line per closed task. `recede` dims the whole line: the ledger under
 * open cards. A row never spells its closing year: when the year changes going
 * down the list, a dim line names it once. `opened` carries a year only when
 * it is not the year the task closed in.
 */
function ledger(tasks: readonly OverviewTask[], g: Geometry, recede: boolean): string[] {
  const thisYear = g.now.getFullYear();
  // A task with no closing date sits in the year of the row above.
  let running = thisYear;
  const years = tasks.map((t) => (running = t.closed === null ? running : yearOf(t.closed)));
  const none = { date: '', time: '' };
  const parts = tasks.map((t, i) => ({
    opened: t.opened === null ? none : stampParts(t.opened, years[i] as number),
    closed: t.closed === null ? none : stampParts(t.closed, years[i] as number),
  }));
  type Side = 'opened' | 'closed';
  const col = (side: Side, part: 'date' | 'time'): number => Math.max(0, ...parts.map((p) => cells(p[side][part])));
  const cell = (side: Side, p: (typeof parts)[number]): string => {
    const time = col(side, 'time') === 0 ? '' : ` ${padEnd(p[side].time, col(side, 'time'))}`;
    return padStart(p[side].date, col(side, 'date')) + time;
  };

  const out: string[] = [];
  let year = thisYear;
  tasks.forEach((t, i) => {
    const p = parts[i] as (typeof parts)[number];
    if (years[i] !== year) {
      year = years[i] as number;
      out.push(`${spaces(g.hang)}${dim(String(year))}`);
    }
    const dates = g.narrow ? padStart(p.closed.date, col('closed', 'date')) : `${cell('opened', p)} → ${cell('closed', p)}`;
    const flag = t.state === 'abandoned' ? 'abandoned' : '';
    const flagCells = flag === '' ? 0 : GAP + cells(flag);
    const title = fit(t.title === '' ? '-' : t.title, g.right - g.hang - GAP - cells(dates) - flagCells);
    const id = padEnd(t.id, g.idWidth);
    const gap = spaces(Math.max(GAP, g.right - g.hang - cells(title) - flagCells - cells(dates)));
    const lead = spaces(MARGIN);
    const between = spaces(GAP);
    if (recede) {
      out.push(dim(`${lead}${id}${between}${title}${flag === '' ? '' : between + flag}${gap}${dates}`.trimEnd()));
    } else {
      const tail = dates.trimEnd();
      const line = `${lead}${id}${between}${title}${flag === '' ? '' : between + red(flag)}`;
      out.push(tail === '' ? line : `${line}${gap}${dim(tail)}`);
    }
  });
  return out;
}

function heading(label: string, count: number): string {
  return `${spaces(MARGIN)}${bold(label)}${spaces(GAP)}${dim(String(count))}`;
}

function hint(text: string, command: string): string {
  return `${spaces(MARGIN)}${dim(text)} ${cyan(command)}`;
}

/** Ids of any width, highest first: `t1000` before `t999`. */
function byIdDesc(a: OverviewTask, b: OverviewTask): number {
  return b.id.length - a.id.length || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/** Newest first, a missing moment last, then by id, highest first. */
function newest(key: (t: OverviewTask) => Moment | null) {
  return (a: OverviewTask, b: OverviewTask): number => {
    const x = key(a);
    const y = key(b);
    if (x !== null && y !== null) return momentMs(y) - momentMs(x) || byIdDesc(a, b);
    if (x !== null) return -1;
    if (y !== null) return 1;
    return byIdDesc(a, b);
  };
}

/** Most recently active first; unknown activity last, by opened, newest first; ties by id, highest first. */
function byActivity(a: OverviewTask, b: OverviewTask): number {
  if (a.active !== null && b.active !== null) return momentMs(b.active) - momentMs(a.active) || byIdDesc(a, b);
  if (a.active !== null) return -1;
  if (b.active !== null) return 1;
  return newest((t) => t.opened)(a, b);
}

/** `yan ls`: the lines to print, the first one blank. */
export function renderOverview(ov: Overview, opts: RenderOptions): string[] {
  const open = ov.tasks.filter((t) => t.state === 'open').sort(byActivity);
  const done = ov.tasks.filter((t) => t.state !== 'open').sort(newest((t) => t.closed));
  const g = geometry(ov.tasks.map((t) => t.id), opts);
  const out = [''];

  if (ov.tasks.length + ov.hidden.open + ov.hidden.done === 0) {
    out.push(hint('no tasks yet — start one with', 'yan task new'), '');
    return out;
  }

  const showOpen = ov.status !== 'done';
  const showDone = ov.status !== 'open';
  const both = showOpen && showDone;

  if (showOpen) {
    if (both) out.push(heading('Open', open.length), '');
    if (open.length === 0) out.push(hint('nothing open — start one with', 'yan task new'), '');
    for (const t of open) out.push(...card(t, g), '');
  }
  if (showDone) {
    if (both) out.push(heading('Done', done.length), '');
    if (done.length === 0) out.push(`${spaces(MARGIN)}${dim('nothing done yet')}`, '');
    else out.push(...ledger(done, g, both && open.length > 0), '');
  }

  if (ov.status === 'done' && ov.hidden.open > 0) out.push(hint(`${ov.hidden.open} open hidden ·`, 'yan ls'), '');
  if (ov.status === 'open' && ov.hidden.done > 0) {
    out.push(hint(`${ov.hidden.done} done hidden ·`, 'yan ls --status=all'), '');
  }
  return out;
}

/** Whether a yan is on the task: `yan show` knows, the overview does not. */
export interface HeaderSession {
  readonly running: boolean;
}

/**
 * The top of `yan show`: the task's card with a state line under the title,
 * the whole Description unclamped, and the meta. The first line is blank; the
 * last is the meta, or the description when there is no meta.
 */
export function renderHeader(t: OverviewTask, session: HeaderSession, opts: RenderOptions): string[] {
  const g = geometry([t.id], opts);
  const pad = spaces(g.hang);
  const state = t.state === 'abandoned'
    ? item('✗ abandoned', red)
    : t.state === 'done' ? dimItem('✓ done') : item('● open', green);
  const resume = `yan continue ${t.id}`;
  const sessionItem = t.state !== 'open'
    ? undefined
    : session.running
      ? item('◉ yan running', green)
      : { plain: `○ no yan running — resume with ${resume}`, painted: `${dim('○ no yan running — resume with')} ${cyan(resume)}` };

  const out = ['', titleLine(t, g)];
  const first = ageColumn(t, g) + state.painted;
  if (sessionItem === undefined) out.push(first);
  else if (cells(state.plain) + 3 + cells(sessionItem.plain) <= g.right - g.hang) out.push(`${first}   ${sessionItem.painted}`);
  else out.push(first, pad + sessionItem.painted);

  const measure = g.right - g.hang;
  const paras = paragraphs(t);
  paras.forEach((p, i) => {
    // A blank line between two paragraphs, none above a bullet: a list sits
    // against whatever led into it.
    if (i > 0 && !isBullet(p)) out.push('');
    for (const l of wrap(p, measure)) out.push(pad + lineText(l));
  });
  out.push(...flow(metaItems(t, g), g));
  return out;
}
