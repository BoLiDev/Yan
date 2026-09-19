import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, repoRoot, runYan } from '../helpers/fixtures.js';
import type { Report, ReportTask } from '../../src/cli/ui/collect.js';

/**
 * `yan ui` against `tests/fixtures/ui-vault`, whose report is written out in
 * its README. The collector is called in process with a pinned "now", so the
 * years of an open task's dates do not move with the calendar; the command is
 * run through `bin/yan` for its flags and for what it leaves behind: nothing.
 */

afterAll(cleanupTempDirs);

let home = '';
let report: Report;

const task = (id: string): ReportTask => {
  const found = report.tasks.find((t) => t.id === id);
  if (found === undefined) throw new Error(`no ${id} in the report`);
  return found;
};

function snapshot(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    out.push(`${full} ${statSync(full).mtimeMs}`);
    if (statSync(full).isDirectory()) out.push(...snapshot(full));
  }
  return out;
}

beforeAll(async () => {
  home = mkYanHome(join(mkTempDir(), 'home'), { withDist: true });
  cpSync(join(repoRoot, 'tests', 'fixtures', 'ui-vault', 'tasks'), join(home, 'tasks'), { recursive: true });
  const previous = process.env.YAN_HOME;
  process.env.YAN_HOME = home;
  const { collectReport } = await import('../../src/cli/ui/collect.js');
  report = collectReport({ since: '2026-08-01', until: null }, new Date('2026-09-18T15:04:05.678Z'));
  if (previous === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previous;
});

describe('the collector', () => {
  it('holds every task, open, done and abandoned, in id order', () => {
    expect(report.version).toBe(2);
    expect(report.generated_at).toBe('2026-09-18T15:04:05Z');
    expect(report.range).toEqual({ since: '2026-08-01', until: null });
    expect(report.tasks.map((t) => `${t.id} ${t.state}`)).toEqual([
      't001 open', 't002 done', 't003 done', 't004 done', 't005 abandoned',
      't006 done', 't007 open', 't008 open', 't009 done', 't010 open',
    ]);
  });

  it('gives a task in the shape its first Description paragraph, its days and its deliverables', () => {
    expect(task('t001')).toEqual({
      id: 't001',
      title: 'pricing page',
      project: 'site',
      state: 'open',
      description: 'A pricing page for the site, with the three plans side by side and a comparison table under them.',
      started: '2026-09-01',
      completed: null,
      deliverables: [
        { mark: 'done', date: '2026-09-10', evidence: 'PR #12', text: 'The three plans side by side, each with its price and what it includes.' },
        { mark: 'done', date: '2026-09-15', evidence: null, text: 'The comparison table under the plans.' },
        { mark: 'todo', date: null, evidence: null, text: 'Yearly prices, with the saving shown.' },
        { mark: 'todo', date: null, evidence: null, text: 'The page linked from the header.' },
        { mark: 'dropped', date: null, evidence: null, text: 'A currency switcher — every customer pays in euros.' },
      ],
    });
  });

  it('keeps markup and replacement patterns in the text as typed', () => {
    const texts = task('t002').deliverables.map((d) => d.text).join('\n');
    expect(texts).toContain('`</script><!-- x -->`');
    expect(texts).toContain('`$&` and `$1`');
    expect(task('t002').deliverables.map((d) => d.evidence)).toEqual([null, 'MR !87', 'PR #31', null]);
  });

  it('dates a finished task’s items against its completion day, not today', () => {
    expect(task('t006').completed).toBe('2026-01-08');
    expect(task('t006').deliverables.map((d) => d.date)).toEqual(['2025-12-30', '2026-01-05']);
  });

  it('gives a free-form or missing brief no description and no deliverables', () => {
    for (const id of ['t003', 't004', 't007']) {
      expect(task(id)).toMatchObject({ description: null, deliverables: [] });
    }
    expect(task('t003').started).toBe('2026-07-01');
    expect(task('t003').completed).toBe('2026-07-15');
  });

  it('takes the project from the first unit, and null without one', () => {
    expect(task('t002').project).toBe('ledger');
    expect(task('t004').project).toBeNull();
  });

  it('gives an abandoned task its closing day as completed', () => {
    expect(task('t005')).toMatchObject({ state: 'abandoned', completed: '2026-08-01' });
  });

  it('keeps an unreadable task, with nothing known about it', () => {
    expect(task('t008')).toEqual({
      id: 't008', title: '', project: null, state: 'open', description: null, started: null, completed: null, deliverables: [],
    });
  });

  it('keeps a delivered item with no date, and leaves a reference with words after it in the text', () => {
    expect(task('t009').deliverables[0]).toEqual({
      mark: 'done', date: null, evidence: null, text: 'PR #53 for the data; the styling after · The box finds pages by title.',
    });
  });

  it('gives an empty Deliverables list no deliverables and keeps the description', () => {
    expect(task('t010')).toMatchObject({ description: 'A newsletter signup at the foot of every page.', deliverables: [] });
  });
});

describe('yan ui', () => {
  const json = async (args: readonly string[]): Promise<Report> => {
    const r = await runYan(home, ['ui', ...args]);
    expect(r.code, r.out).toBe(0);
    return JSON.parse(r.stdout) as Report;
  };

  it('prints the report with --json, every task and no range without flags', async () => {
    const before = snapshot(home);
    const printed = await json(['--json']);
    expect(printed.range).toBeNull();
    expect(printed.tasks.map((t) => t.id)).toEqual(report.tasks.map((t) => t.id));
    expect(printed.tasks.find((t) => t.id === 't002')).toEqual(task('t002'));
    expect(printed.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(snapshot(home)).toEqual(before);
  });

  it('writes the dates it is given into the range, either one alone', async () => {
    expect((await json(['--json', '--since', '2026-08-19', '--until', '2026-09-18'])).range).toEqual({ since: '2026-08-19', until: '2026-09-18' });
    expect((await json(['--json', '--since', '2026-08-19'])).range).toEqual({ since: '2026-08-19', until: null });
    expect((await json(['--json', '--until', '2026-09-18'])).range).toEqual({ since: null, until: '2026-09-18' });
  });

  it('holds every task whatever the dates say', async () => {
    expect((await json(['--json', '--since', '2030-01-01'])).tasks).toHaveLength(10);
  });

  it('refuses a date that is not YYYY-MM-DD, or not a day, or a range that runs backwards', async () => {
    for (const [args, says] of [
      [['--since', 'last month'], "--since takes a date as YYYY-MM-DD, not 'last month'"],
      [['--since', '2026-9-01'], "--since takes a date as YYYY-MM-DD, not '2026-9-01'"],
      [['--until', '2026-02-30'], "--until takes a date as YYYY-MM-DD, not '2026-02-30'"],
      [['--since', '2026-09-10', '--until', '2026-09-01'], '--since 2026-09-10 is after --until 2026-09-01'],
    ] as const) {
      const r = await runYan(home, ['ui', '--json', ...args]);
      expect(r.code, r.out).toBe(2);
      expect(r.stderr).toBe(`ui: ${says}\n`);
      expect(r.stdout).toBe('');
    }
  });

  it('says there is no page yet without --json, and writes nothing', async () => {
    const before = snapshot(home);
    const r = await runYan(home, ['ui']);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe('ui: the page is not built yet - pass --json for the data\n');
    expect(snapshot(home)).toEqual(before);
  });
});
