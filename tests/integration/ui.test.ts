import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
    expect(report.version).toBe(3);
    expect(report.generated_at).toBe('2026-09-18T15:04:05Z');
    expect(report.range).toEqual({ since: '2026-08-01', until: null });
    expect(report.tasks.map((t) => `${t.id} ${t.state}`)).toEqual([
      't001 open', 't002 done', 't003 done', 't004 done', 't005 abandoned',
      't006 done', 't007 open', 't008 open', 't009 done', 't010 open',
    ]);
  });

  it('gives a task its brief as prose, its days and its record as it is written', () => {
    expect(task('t001')).toEqual({
      id: 't001',
      title: 'pricing page',
      project: 'site',
      state: 'open',
      brief: [
        'The site has no page that says what anything costs, so every enquiry starts with someone asking. Three plans exist and nobody outside the company can name them.',
        '',
        'What has to be true at the end:',
        '- a visitor can compare the three plans without writing to us;',
        '- the yearly price says what it saves.',
      ].join('\n'),
      started: '2026-09-01',
      completed: null,
      deliverables: [
        { id: 'd1', text: 'The pricing page shows the three plans side by side, each with its price and what it includes.', status: 'done', doneAt: '2026-09-10', refs: ['PR #12'] },
        { id: 'd2', text: 'A table under the plans compares them feature by feature.', status: 'done', doneAt: '2026-09-15', refs: ['PR #13', 'PR #14'] },
        { id: 'd3', text: 'Every plan carries a yearly price, and the page says what paying yearly saves.', status: 'todo' },
        { id: 'd4', text: 'The header links to the pricing page from every page of the site.', status: 'todo' },
        { id: 'd5', text: "The page shows its prices in the visitor's own currency.", status: 'abandoned', reason: 'every customer pays in euros' },
      ],
    });
  });

  it('keeps markup and replacement patterns as typed, in the brief, a deliverable, a reason and a ref', () => {
    const t = task('t002');
    expect(t.brief).toContain('`</script><!-- x -->`');
    expect(t.deliverables.map((d) => d.text).join('\n')).toContain('`$&`, `$1` and `$$` in an invoice print as the literal text');
    const abandoned = t.deliverables[3];
    expect(abandoned).toMatchObject({ status: 'abandoned' });
    expect(abandoned && 'reason' in abandoned ? abandoned.reason : '').toContain('`</script><!-- x -->` and `$&`');
    expect(t.deliverables[2]).toMatchObject({ refs: ['PR #31', 'PR #32 <!-- squashed -->'] });
  });

  it('never reads deliverables out of a brief: an old two-section one has none', () => {
    expect(task('t003').deliverables).toEqual([]);
    expect(task('t003').brief).toBe('Nightly backups of the ledger database, kept for thirty days.');
    expect(task('t003')).toMatchObject({ started: '2026-07-01', completed: '2026-07-15' });
  });

  it('gives a task with neither file no brief and no deliverables', () => {
    expect(task('t004')).toEqual({
      id: 't004', title: 'clean up old branches', project: null, state: 'done',
      brief: null, started: '2026-06-10', completed: '2026-06-30', deliverables: [],
    });
  });

  it('gives a record that does not validate no deliverables, and does not fail', () => {
    expect(task('t007').deliverables).toEqual([]);
    expect(task('t007').brief).toContain('The autumn release goes out in a fortnight');
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
      id: 't008', title: '', project: null, state: 'open', brief: null, started: null, completed: null, deliverables: [],
    });
  });

  it('keeps a delivered item with nothing proving it, and one dated either side of a year', () => {
    expect(task('t009').deliverables[0]).toEqual({ id: 'd1', text: 'The search box finds any page by its title.', status: 'done', doneAt: '2026-09-09' });
    expect(task('t006').deliverables.map((d) => (d.status === 'done' ? d.doneAt : null))).toEqual(['2025-12-30', '2026-01-05']);
  });

  it('gives an empty record no deliverables and keeps the brief', () => {
    expect(task('t010')).toMatchObject({ brief: expect.stringContaining('The newsletter has one way in'), deliverables: [] });
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

  it('writes nothing with --json, even given --out', async () => {
    const before = snapshot(home);
    const file = join(mkTempDir(), 'report.html');
    await json(['--json', '--out', file]);
    expect(existsSync(file)).toBe(false);
    expect(snapshot(home)).toEqual(before);
  });

  it('writes the page to the machine directory by default, outside the vault, and prints its path', async () => {
    const machine = mkTempDir();
    const before = snapshot(home);
    const r = await runYan(home, ['ui', '--no-open'], { YAN_MACHINE_DIR: machine });
    expect(r.code, r.out).toBe(0);
    const file = join(machine, 'ui', 'report.html');
    expect(r.stdout).toBe(`${file}\n`);
    expect(readFileSync(file, 'utf8')).toContain('id="yan-data">{"version":3,');
    expect(snapshot(home)).toEqual(before);

    // One file, overwritten each run.
    expect((await runYan(home, ['ui', '--no-open'], { YAN_MACHINE_DIR: machine })).code).toBe(0);
    expect(readdirSync(join(machine, 'ui'))).toEqual(['report.html']);
  });

  it('writes to --out, creating its directory, with the report --json prints and the range it was given', async () => {
    const file = join(mkTempDir(), 'deep', 'er', 'page.html');
    const r = await runYan(home, ['ui', '--no-open', '--out', file, '--since', '2026-08-01', '--until', '2026-08-31']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toBe(`${file}\n`);
    const html = readFileSync(file, 'utf8');
    expect(html).not.toContain('/*YAN_DATA*/');
    expect(html).not.toContain('YAN_MOCK');
    const m = /id="yan-data">([\s\S]*?)<\/script>/.exec(html);
    const page = JSON.parse(m?.[1] ?? 'null') as Report;
    const printed = await json(['--json', '--since', '2026-08-01', '--until', '2026-08-31']);
    expect({ ...page, generated_at: '' }).toEqual({ ...printed, generated_at: '' });
    expect(page.range).toEqual({ since: '2026-08-01', until: '2026-08-31' });
  });

  it('opens the page with $YAN_OPENER, and not with --no-open', async () => {
    const dir = mkTempDir();
    const record = join(dir, 'opened');
    const opener = join(dir, 'opener.sh');
    writeFileSync(opener, `#!/usr/bin/env bash\nprintf '%s\\n' "$1" > "${record}"\nexit 1\n`);
    const file = join(dir, 'page with spaces.html');

    const quiet = await runYan(home, ['ui', '--no-open', '--out', file], { YAN_OPENER: `bash ${opener}` });
    expect(quiet.code, quiet.out).toBe(0);
    expect(existsSync(record)).toBe(false);

    // The opener's exit code must never become this command's.
    const r = await runYan(home, ['ui', '--out', file], { YAN_OPENER: `bash ${opener}` });
    expect(r.code, r.out).toBe(0);
    expect(readFileSync(record, 'utf8')).toBe(`${file}\n`);
  });

  it('says so when it cannot write the page', async () => {
    const r = await runYan(home, ['ui', '--no-open', '--out', mkTempDir()]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^ui: cannot write /);
  });
});
