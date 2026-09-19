import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Overview, OverviewTask } from './overview.js';
import { renderHeader, renderOverview } from './render.js';
import { age, ageTier, ago, stamp } from './time.js';
import type { Moment } from './when.js';
import { clamp, lineText, wrap } from './wrap.js';
import { cells, fit, padEnd, padStart } from '../shared/style.js';

/**
 * The print of `yan ls` and the `yan show` header, at the seams the design
 * named (t128, artifacts/uix/design.md, "For the coding shift"): pure
 * functions, fed made-up tasks, a fixed clock and a width. Local time: every
 * moment here is built from local fields, so the suite passes in any zone.
 */

const NOW = new Date(2026, 8, 18, 19, 40); // 2026-09-18 19:40, local
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const two = (n: number): string => String(n).padStart(2, '0');
const sec = (ms: number): Moment => ({ at: `${new Date(ms).toISOString().slice(0, 19)}Z`, precision: 'second', source: 'task.json' });
const before = (ms: number): Moment => sec(NOW.getTime() - ms);
const day = (y: number, m: number, d: number): Moment => ({ at: `${y}-${two(m)}-${two(d)}`, precision: 'day', source: 'log' });
const daysBefore = (n: number): Moment => {
  const d = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n);
  return day(d.getFullYear(), d.getMonth() + 1, d.getDate());
};

function task(over: Partial<OverviewTask> & { id: string }): OverviewTask {
  return {
    title: `task ${over.id}`,
    state: 'open',
    description: 'A short description.',
    opened: before(3 * DAY),
    closed: null,
    changed: { state: 'none' },
    active: before(2 * MIN),
    ...over,
  };
}

function done(id: string, opened: Moment | null, closed: Moment | null, extra: Partial<OverviewTask> = {}): OverviewTask {
  return task({ id, state: 'done', opened, closed, changed: null, active: closed, ...extra });
}

function ls(tasks: OverviewTask[], status: Overview['status'] = 'open', hidden = { open: 0, done: 0 }, cols = 80): string[] {
  return renderOverview({ version: 2, status, tasks, hidden }, { now: NOW, cols });
}

let saved: { NO_COLOR?: string; FORCE_COLOR?: string };
beforeEach(() => {
  saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };
  process.env.NO_COLOR = '1';
  delete process.env.FORCE_COLOR;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('cells, padding and fit', () => {
  it('count a wide character as two cells, and pad by cells', () => {
    expect(cells('ab冥想')).toBe(6);
    expect(padEnd('冥', 4)).toBe('冥  ');
    expect(padStart('冥', 4)).toBe('  冥');
    expect(padEnd('toolong', 3)).toBe('toolong');
  });

  it('cut a title that is all wide characters, leaving one cell unused at an odd width', () => {
    const cut = fit('冥想呼吸引导静坐', 7);
    expect(cut).toBe('冥想呼…');
    expect(cells(cut)).toBe(7);
    expect(fit('冥想呼吸引导静坐', 8)).toBe('冥想呼…');
  });

  it('never leave a space before the ellipsis', () => {
    expect(fit('abc def ghi', 5)).toBe('abc…');
  });
});

describe('the description', () => {
  it('ends exactly at three lines with no ellipsis', () => {
    const lines = wrap('aaaa bbbb cccc', 4);
    expect(clamp(lines, 3, 4)).toEqual(['aaaa', 'bbbb', 'cccc']);
  });

  it('ends in an ellipsis when a second paragraph follows three lines', () => {
    expect(clamp(wrap('aaa bbb ccc', 4), 3, 4, true)).toEqual(['aaa', 'bbb', 'ccc…']);
  });

  it('gives up whole words and trailing punctuation for the ellipsis', () => {
    expect(clamp(wrap('one two. three four five', 9), 1, 9)).toEqual(['one two…']);
  });

  it('keeps closing punctuation off the start of a line and opening punctuation off the end', () => {
    const lines = wrap('一二三（四五）。六', 6).map(lineText);
    for (const l of lines) {
      expect(l.startsWith('。')).toBe(false);
      expect(l.startsWith('）')).toBe(false);
      expect(l.endsWith('（')).toBe(false);
    }
  });

  it('cuts a unit wider than the line at the edge', () => {
    expect(wrap('https://example.com/a/very/long/path', 10).map(lineText)).toEqual(['https://ex', 'ample.com/', 'a/very/lon', 'g/path']);
  });

  it('prints the first paragraph clamped on a card, and a placeholder for none', () => {
    const text = ls([
      task({ id: 't1', description: 'First paragraph.\n\nSecond paragraph.', active: before(5 * HOUR) }),
      task({ id: 't2', description: null, active: before(6 * HOUR) }),
    ]).join('\n');
    expect(text).toContain(' 5h    First paragraph…');
    expect(text).not.toContain('Second paragraph');
    expect(text).toContain(' 6h    no description in brief.md');
  });
});

describe('age, ago and stamp', () => {
  it('floor the age at every boundary', () => {
    expect(age(before(30 * 1000), NOW)).toBe('now');
    expect(age(before(-5 * MIN), NOW)).toBe('now');
    expect(age(before(59 * MIN + 59_000), NOW)).toBe('59m');
    expect(age(before(60 * MIN), NOW)).toBe('1h');
    expect(age(before(47 * HOUR + 59 * MIN), NOW)).toBe('47h');
    expect(age(before(48 * HOUR), NOW)).toBe('2d');
    expect(age(before(29 * DAY + 23 * HOUR), NOW)).toBe('29d');
    expect(age(before(30 * DAY), NOW)).toBe('30d');
    expect(age(before(99 * DAY + 23 * HOUR), NOW)).toBe('99d');
    expect(age(before(100 * DAY), NOW)).toBe('3mo');
    expect(age(before(24 * 30 * DAY), NOW)).toBe('1y');
    expect(age(before(3 * 365 * DAY), NOW)).toBe('3y');
  });

  it('colour the age by how stale it is', () => {
    expect(ageTier(before(59 * MIN), NOW)).toBe('fresh');
    expect(ageTier(before(60 * MIN), NOW)).toBe('plain');
    expect(ageTier(before(47 * HOUR), NOW)).toBe('plain');
    expect(ageTier(before(48 * HOUR), NOW)).toBe('quiet');
    expect(ageTier(before(29 * DAY), NOW)).toBe('quiet');
    expect(ageTier(before(30 * DAY), NOW)).toBe('stale');
  });

  it('count a day-only age in calendar days, and never call it fresh', () => {
    expect(age(daysBefore(0), NOW)).toBe('<1d');
    expect(age(daysBefore(1), NOW)).toBe('1d');
    expect(age(daysBefore(3), NOW)).toBe('3d');
    expect(ageTier(daysBefore(0), NOW)).toBe('plain');
  });

  it('floor ago, and give a date from 100 days', () => {
    expect(ago(before(40 * 1000), NOW)).toBe('now');
    expect(ago(before(59 * MIN + 59_000), NOW)).toBe('59m ago');
    expect(ago(before(60 * MIN), NOW)).toBe('1h ago');
    expect(ago(before(47 * HOUR + 59 * MIN), NOW)).toBe('47h ago');
    expect(ago(before(48 * HOUR), NOW)).toBe('2d ago');
    expect(ago(before(99 * DAY + 23 * HOUR), NOW)).toBe('99d ago');
    expect(ago(sec(new Date(2026, 5, 10, 12, 0).getTime()), NOW)).toBe('06-10');
    expect(ago(sec(new Date(2025, 2, 2, 12, 0).getTime()), NOW)).toBe('2025-03-02');
    expect(ago(daysBefore(0), NOW)).toBe('today');
    expect(ago(daysBefore(3), NOW)).toBe('3d ago');
  });

  it('stamp to the minute, the year only when it is not this one, and a day as a date', () => {
    expect(stamp(sec(new Date(2026, 8, 18, 14, 2).getTime()), NOW)).toBe('09-18 14:02');
    expect(stamp(sec(new Date(2025, 11, 24, 9, 5).getTime()), NOW)).toBe('2025-12-24 09:05');
    expect(stamp(day(2026, 9, 9), NOW)).toBe('09-09');
  });
});

describe('yan ls', () => {
  it('lays out a card at 80 columns, nothing ending in spaces', () => {
    const lines = ls(
      [task({ id: 't131', title: 'overview for yan ls', opened: sec(new Date(2026, 8, 18, 14, 2).getTime()), changed: { state: 'known', at: before(5 * MIN) } })],
      'open',
      { open: 0, done: 27 },
    );
    expect(lines).toEqual([
      '',
      ' t131  overview for yan ls',
      ' 2m    A short description.',
      '       opened 09-18 14:02 · changed 5m ago',
      '',
      ' 27 done hidden · yan ls --status=all',
      '',
    ]);
  });

  it('keeps an unlinked repository apart from nothing to report, and does not fail', () => {
    const text = ls([
      task({ id: 't124', changed: { state: 'unknown' }, active: daysBefore(2), opened: day(2026, 9, 6) }),
      task({ id: 't126', changed: { state: 'none' }, active: before(3 * HOUR), opened: day(2026, 9, 9) }),
    ]).join('\n');
    expect(text).toContain('       opened 09-06 · changed unknown');
    expect(text).toMatch(/opened 09-09$/m);
  });

  it('sizes the id column to the widest id, and sorts by activity, unknown last', () => {
    const lines = ls([
      task({ id: 't99', active: before(10 * MIN) }),
      task({ id: 't1000', active: before(1 * MIN) }),
      task({ id: 't5', active: null, opened: before(DAY) }),
      task({ id: 't6', active: null, opened: before(2 * DAY) }),
    ]);
    const titles = lines.filter((l) => /^ t\d/.test(l));
    expect(titles).toEqual([' t1000  task t1000', ' t99    task t99', ' t5     task t5', ' t6     task t6']);
    expect(lines).toContain(' 10m    A short description.');
    expect(lines).toContain('        A short description.'); // unknown activity leaves the column blank
  });

  it('survives a task with every nullable field null', () => {
    const bare = task({ id: 't1', title: '', description: null, opened: null, changed: null, active: null });
    const closed = done('t2', null, null, { title: '' });
    expect(() => ls([bare, closed], 'all')).not.toThrow();
    const text = ls([bare, closed], 'all').join('\n');
    expect(text).toContain(' t1    -');
    expect(text).toContain(' t2    -');
    expect(() => renderHeader(bare, { running: false }, { now: NOW, cols: 80 })).not.toThrow();
  });

  it('prints the empty states', () => {
    expect(ls([])).toEqual(['', ' no tasks yet — start one with yan task new', '']);
    expect(ls([], 'open', { open: 0, done: 3 })).toEqual([
      '',
      ' nothing open — start one with yan task new',
      '',
      ' 3 done hidden · yan ls --status=all',
      '',
    ]);
    expect(ls([], 'done', { open: 2, done: 0 })).toEqual(['', ' nothing done yet', '', ' 2 open hidden · yan ls', '']);
  });

  it('never goes under 32 columns or over 96', () => {
    const long = task({ id: 't1', title: 'x'.repeat(200), description: 'word '.repeat(100) });
    for (const [cols, right] of [[10, 31], [200, 95]] as const) {
      const widest = Math.max(...ls([long], 'open', undefined, cols).map(cells));
      expect(widest).toBe(right);
    }
  });
});

describe('the ledger', () => {
  const at = (y: number, m: number, d: number, h = 12, mi = 0): Moment => sec(new Date(y, m - 1, d, h, mi).getTime());

  it('aligns dates and reserves a time only where some row has one', () => {
    const lines = ls(
      [
        done('t130', at(2026, 9, 16, 16, 40), at(2026, 9, 17, 19, 40)),
        done('t115', day(2026, 8, 25), day(2026, 8, 26)),
        done('t112', day(2026, 8, 21), day(2026, 8, 22), { state: 'abandoned', title: 'blade: engage icon, second attempt at the sprite sheet approach' }),
      ],
      'done',
    );
    for (const l of lines) expect(cells(l)).toBeLessThanOrEqual(79);
    expect(lines.slice(1, 4)).toEqual([
      ' t130  task t130                                      09-16 16:40 → 09-17 19:40',
      ' t115  task t115                                      08-25       → 08-26',
      ' t112  blade: engage icon, second attemp…  abandoned  08-21       → 08-22',
    ]);
  });

  it('reserves no time column when no row has a time', () => {
    const lines = ls([done('t2', day(2026, 8, 1), day(2026, 8, 3)), done('t1', day(2026, 7, 1), day(2026, 7, 2))], 'done');
    expect(lines[1]).toBe(' t2    task t2                                                    08-01 → 08-03');
  });

  it('names a year once when the list crosses into it, and spells an opening year only when it differs', () => {
    const lines = ls(
      [done('t102', day(2026, 7, 20), day(2026, 7, 22)), done('t101', day(2024, 12, 24), day(2025, 1, 3))],
      'done',
    );
    expect(lines.slice(1, 4)).toEqual([
      ' t102  task t102                                                  07-20 → 07-22',
      '       2025',
      ' t101  task t101                                             2024-12-24 → 01-03',
    ]);
  });

  it('keeps the closing date alone when narrow', () => {
    const lines = ls([done('t2', at(2026, 8, 1), at(2026, 8, 3))], 'done', undefined, 40);
    expect(lines[1]).toBe(' t2    task t2                    08-03');
  });

  it('groups open and done under headings, with no footer', () => {
    const lines = ls([task({ id: 't3' }), done('t2', day(2026, 8, 1), day(2026, 8, 3))], 'all');
    expect(lines[1]).toBe(' Open  1');
    expect(lines).toContain(' Done  1');
    expect(lines.join('\n')).not.toContain('hidden');
  });
});

describe('the yan show header', () => {
  it('prints the card with a state line, the whole description and no pane', () => {
    const t = task({
      id: 't129',
      description: `${'word '.repeat(40).trim()}\n\nsecond paragraph`,
      active: before(3 * HOUR),
      changed: { state: 'known', at: before(26 * HOUR) },
      opened: sec(new Date(2026, 8, 15, 17, 40).getTime()),
    });
    const lines = renderHeader(t, { running: false }, { now: NOW, cols: 80 });
    expect(lines[0]).toBe('');
    expect(lines[1]).toBe(' t129  task t129');
    expect(lines[2]).toBe(' 3h    ● open   ○ no yan running — resume with yan continue t129');
    expect(lines).toContain('       second paragraph');
    expect(lines).toContain('');
    expect(lines.at(-1)).toBe('       opened 09-15 17:40 · changed 26h ago');
    expect(lines.join('\n')).not.toContain('…');
  });

  it('says a yan is running without naming its pane, and puts the session on its own line when narrow', () => {
    expect(renderHeader(task({ id: 't1' }), { running: true }, { now: NOW, cols: 80 })[2]).toBe(' 2m    ● open   ◉ yan running');
    const narrow = renderHeader(task({ id: 't1' }), { running: false }, { now: NOW, cols: 40 });
    expect(narrow[2]).toBe(' 2m    ● open');
    expect(narrow[3]).toBe('       ○ no yan running — resume with yan continue t1');
  });

  it('gives a closed task no session part, and its closing stamp', () => {
    const t = done('t130', sec(new Date(2026, 8, 16, 16, 40).getTime()), sec(new Date(2026, 8, 17, 19, 40).getTime()));
    const lines = renderHeader(t, { running: false }, { now: NOW, cols: 80 });
    expect(lines[2]).toBe(' 24h   ✓ done');
    expect(lines.at(-1)).toBe('       opened 09-16 16:40 · closed 09-17 19:40');
    expect(renderHeader({ ...t, state: 'abandoned' }, { running: false }, { now: NOW, cols: 80 })[2]).toBe(' 24h   ✗ abandoned');
  });
});
