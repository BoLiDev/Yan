import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkClone,
  mkCommit,
  mkTempDir,
  mkYanHome,
  registerRepo,
} from '../../../tests/helpers/fixtures.js';
import { claudeProjectSlug, type HarnessEnv } from '../../externals/harness/index.js';
import type { LeaseRow } from '../../externals/worktree/index.js';
import { Task } from '../../records/task/index.js';
import type { ActiveDeps, HerdrAgent } from './active.js';
import { taskActive } from './active.js';
import { taskChanged } from './changed.js';
import { briefDescription } from './description.js';
import { overview } from './overview.js';
import { inferYears, logTimes, type Moment } from './when.js';

afterAll(cleanupTempDirs);

// --- the Description ----------------------------------------------------------

describe('the Description in brief.md', () => {
  it('is the text under ## Description, up to the next ##', () => {
    const brief = '# t1 title\n\n## Description\n\nWhat it is for.\n\n## Deliverables\n\n- [ ] one\n';
    expect(briefDescription(brief)).toBe('What it is for.');
  });

  it('keeps paragraphs apart and joins the hard wraps inside one', () => {
    const brief = [
      '# t1 title', '', '## Description', '',
      '`user` wants one command that shows what they are working',
      'on right now:  which tasks are open.',
      '',
      'A second paragraph,',
      'wrapped too.',
      '',
      '### a sub-heading stays in',
      '## Deliverables',
    ].join('\n');
    expect(briefDescription(brief)).toBe(
      '`user` wants one command that shows what they are working on right now: which tasks are open.\n\n' +
      'A second paragraph, wrapped too.\n\n### a sub-heading stays in',
    );
  });

  it('joins two wide characters with nothing, and a wide one to a narrow one with a space', () => {
    const brief = '# t129 冥想\n\n## Description\n\n给静坐页面加一个呼吸引导：一个随吸气放大、\n呼气收缩的圆，节奏可以调（4-7-8\nbox breathing）。\n';
    expect(briefDescription(brief)).toBe('给静坐页面加一个呼吸引导：一个随吸气放大、呼气收缩的圆，节奏可以调（4-7-8 box breathing）。');
  });

  it('without the heading, is everything under the # title up to the first heading', () => {
    const brief = '# t1 title\n\nWritten by task new\nacross two lines.\n\nAnd this one too.\n\n## Goal\n\nnot this.\n';
    expect(briefDescription(brief)).toBe('Written by task new across two lines.\n\nAnd this one too.');
  });

  it('keeps a bullet on its own line instead of folding it into the paragraph above', () => {
    const brief = [
      '# t1 title', '',
      'Two things are wrong with the report today:', '',
      '- it reads like a log, because the items are written',
      '  after the fact;',
      '- a task with nothing in it opens onto an empty panel.', '',
      'Both come from the same place.', '',
    ].join('\n');
    expect(briefDescription(brief)).toBe(
      'Two things are wrong with the report today:\n' +
      '- it reads like a log, because the items are written after the fact;\n' +
      '- a task with nothing in it opens onto an empty panel.\n\n' +
      'Both come from the same place.',
    );
  });

  it('is null when there is neither', () => {
    expect(briefDescription('# t1 title\n\n## Goal\n\nsomething\n')).toBeNull();
    expect(briefDescription('# t1 title\n\n')).toBeNull();
    expect(briefDescription('no title at all\n')).toBeNull();
    expect(briefDescription('# t1 title\n\n## Description\n\n## Deliverables\n')).toBeNull();
  });
});

// --- times ----------------------------------------------------------------------

describe('dates off log.md', () => {
  it('infers the year across a year boundary', () => {
    const now = new Date(2026, 0, 3, 12, 0);
    expect(inferYears(['12-24', '12-30', '01-02'], now)).toEqual(['2025-12-24', '2025-12-30', '2026-01-02']);
    expect(inferYears(['12-24', '12-30'], now)).toEqual(['2025-12-24', '2025-12-30']);
    expect(inferYears(['09-18'], new Date(2026, 8, 18))).toEqual(['2026-09-18']);
    expect(inferYears(['09-19'], new Date(2026, 8, 18)), 'nothing is in the future').toEqual(['2025-09-19']);
  });

  it('keeps a line written a day out of order in the same year', () => {
    expect(inferYears(['08-29', '08-31', '08-30', '08-31'], new Date(2026, 8, 18)))
      .toEqual(['2026-08-29', '2026-08-31', '2026-08-30', '2026-08-31']);
  });

  it('takes the first entry as opened and the closing entry as closed, to the day', () => {
    const log = [
      '# t101 ported side writes', '',
      '- 12-24  started    task created',
      '- 12-30  task marked done',
      '- 01-02  agreed     a later note',
    ].join('\n');
    const t = logTimes(log, new Date(2026, 0, 5));
    expect(t.opened).toEqual({ at: '2025-12-24', precision: 'day', source: 'log' });
    expect(t.closed).toEqual({ at: '2025-12-30', precision: 'day', source: 'log' });
    expect(t.last).toEqual({ at: '2026-01-02', precision: 'day', source: 'log' });
  });

  it('reads the closing line abandon and today\'s done write', () => {
    expect(logTimes('- 09-01  started    x\n- 09-02  changed    task abandoned — gone\n', new Date(2026, 8, 18)).closed?.at).toBe('2026-09-02');
    expect(logTimes('- 09-01  started    x\n- 09-03  delivered  task marked done; 1 of 1 tree(s) returned\n', new Date(2026, 8, 18)).closed?.at).toBe('2026-09-03');
    expect(logTimes('- 09-01  started    x\n', new Date(2026, 8, 18)).closed).toBeUndefined();
    expect(logTimes('', new Date())).toEqual({});
  });
});

// --- against a vault ----------------------------------------------------------------

let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir());
  process.env.YAN_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

const noHerdr = (): ReadonlyMap<string, HerdrAgent> => new Map();

function deps(harnessHome: string, herdr = noHerdr): ActiveDeps {
  const harness: HarnessEnv = { home: harnessHome, processes: () => new Map() };
  return { harness, herdr, mainKind: () => 'claude' };
}

const noLeases = (): readonly LeaseRow[] => [];

describe('the overview record', () => {
  it('tells a day-only time from one known to the second', () => {
    Task.create('t1', 'new style');
    Task.create('t2', 'old style');
    const t2 = new Task('t2');
    writeFileSync(t2.file, JSON.stringify({ version: 1, id: 't2', title: 'old style', complete: true, units: [] }));
    writeFileSync(join(t2.dir, 'log.md'), '# t2 old style\n\n- 08-01  started    x\n- 08-03  task marked done\n');
    new Task('t1').setComplete(true);

    const o = overview('all', { now: new Date(2026, 8, 18), leasesOf: noLeases, active: deps(mkTempDir()) });
    const [one, two] = o.tasks;
    expect(one?.opened?.precision).toBe('second');
    expect(one?.opened?.source).toBe('task.json');
    expect(one?.closed?.precision).toBe('second');
    expect(two?.opened).toEqual({ at: '2026-08-01', precision: 'day', source: 'log' });
    expect(two?.closed).toEqual({ at: '2026-08-03', precision: 'day', source: 'log' });
    expect(two?.active).toEqual({ at: '2026-08-03', precision: 'day', source: 'log' });
    expect(two?.changed, 'a done task is not looked at').toBeNull();
  });

  it('filters by status and counts what it hid, abandoned as done', () => {
    Task.create('t1', 'open one');
    Task.create('t2', 'done one');
    Task.create('t3', 'abandoned one');
    new Task('t2').setComplete(true);
    new Task('t3').setAbandoned();
    const d = { leasesOf: noLeases, active: deps(mkTempDir()) };

    const open = overview('open', d);
    expect(open.tasks.map((t) => t.id)).toEqual(['t1']);
    expect(open.hidden).toEqual({ open: 0, done: 2 });
    const done = overview('done', d);
    expect(done.tasks.map((t) => [t.id, t.state])).toEqual([['t2', 'done'], ['t3', 'abandoned']]);
    expect(done.hidden).toEqual({ open: 1, done: 0 });
    expect(overview('all', d).hidden).toEqual({ open: 0, done: 0 });
  });
});

describe('changed', () => {
  it('is unknown for a repository not linked here, none for one with nothing to report, known for a branch', async () => {
    const tmp = mkTempDir();
    const bare = await mkBareRemote(join(tmp, 'remote.git'));
    const clone = await mkClone(bare, join(tmp, 'widget'));
    registerRepo(home, 'widget', clone, { url: bare });
    await fxGit(['-C', clone, 'checkout', '-b', 'yan/t1-r1']);
    await mkCommit(clone, 'a.txt', 'a');
    await fxGit(['-C', clone, 'checkout', 'main']);
    // Registered in the portable half only: the vault knows it, this machine does not.
    writeFileSync(join(home, 'repos.json'), JSON.stringify({ version: 1, widget: { url: bare }, faraway: { url: 'git@example.com:x/y.git' } }));

    Task.create('t1', 'unlinked');
    new Task('t1').addUnit('app', 'faraway', 'main', { branch: 'yan/t1-r1' });
    Task.create('t2', 'nothing to report');
    new Task('t2').addUnit('app', 'widget', 'main', { branch: 'yan/t2-r1' });
    Task.create('t3', 'a branch with a commit');
    new Task('t3').addUnit('app', 'widget', 'main', { branch: 'yan/t1-r1' });
    Task.create('t4', 'one linked, one not');
    new Task('t4').addUnit('far', 'faraway', 'main', { branch: 'x' });
    new Task('t4').addUnit('near', 'widget', 'main', { branch: 'yan/t1-r1' });

    expect(taskChanged(new Task('t1').read(), noLeases)).toEqual({ state: 'unknown' });
    expect(taskChanged(new Task('t2').read(), noLeases)).toEqual({ state: 'none' });
    const t3 = taskChanged(new Task('t3').read(), noLeases);
    expect(t3.state).toBe('known');
    expect(t3.state === 'known' ? t3.at.source : '').toBe('branch');
    expect(taskChanged(new Task('t4').read(), noLeases).state, 'unknown only when nothing could be read').toBe('known');

    // …and the command around it does not fail.
    const o = overview('open', { leasesOf: noLeases, active: deps(mkTempDir()) });
    expect(o.tasks.find((t) => t.id === 't1')?.changed).toEqual({ state: 'unknown' });
  });

  it('reads a held tree: its HEAD, and the newest file git status lists', async () => {
    const tmp = mkTempDir();
    const bare = await mkBareRemote(join(tmp, 'remote.git'));
    const clone = await mkClone(bare, join(tmp, 'widget'));
    registerRepo(home, 'widget', clone, { url: bare });
    const tree = await mkClone(bare, join(tmp, 'tree'));
    Task.create('t1', 'held');
    new Task('t1').addUnit('app', 'widget', 'main', { branch: 'nowhere' });
    const leases = (): readonly LeaseRow[] => [
      { slot: 1, path: tree, branch: 'main', base: 'main', holder: 't1/app/s1', lease_id: 'x', at: 0 },
      { slot: 2, path: join(tmp, 'gone'), branch: 'main', base: 'main', holder: 't9/app', lease_id: 'y', at: 0 },
    ];

    const head = taskChanged(new Task('t1').read(), leases);
    expect(head.state).toBe('known');
    writeFileSync(join(tree, 'wip.txt'), 'x\n');
    const future = Date.now() / 1000 + 3600;
    utimesSync(join(tree, 'wip.txt'), future, future);
    const dirty = taskChanged(new Task('t1').read(), leases);
    expect(dirty.state === 'known' ? Date.parse(dirty.at.at) : 0).toBe(Math.floor(future) * 1000);
    expect(dirty.state === 'known' ? dirty.at.source : '').toBe('tree');
  });
});

describe('active, rung by rung', () => {
  const tree = '/work/trees/1/app';
  const SID = 'aaaa-bbbb';
  const T = Date.parse('2026-09-18T10:00:00Z');
  const lastLog: Moment = { at: '2026-09-17', precision: 'day', source: 'log' };

  function shift(sid: string, meta: Record<string, unknown>): string {
    const run = join(home, 'tasks', 't1', 'shifts', sid, 'run');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'meta.json'), JSON.stringify({ version: 1, agent: 'claude', tree, workdir: tree, at: '2026-09-18T09:00:00Z', ...meta }));
    return run;
  }

  function sessionFile(harnessHome: string, at: number): void {
    const file = join(harnessHome, '.claude', 'projects', claudeProjectSlug(tree), `${SID}.jsonl`);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{}\n');
    utimesSync(file, at / 1000, at / 1000);
  }

  it('1: the session file, by the id in the dispatch record', () => {
    Task.create('t1', 'x');
    const run = shift('s1', { agent_session: SID });
    writeFileSync(join(run, 'pulse'), `${T / 1000 + 50} ${T / 1000 + 60} abc\n`);
    const h = mkTempDir();
    sessionFile(h, T);
    expect(taskActive('t1', lastLog, deps(h))).toEqual({ at: '2026-09-18T10:00:00Z', precision: 'second', source: 'session' });
  });

  it('1: the session file, by the id Herdr reports for the pane', () => {
    Task.create('t1', 'x');
    shift('s1', { pane: 'w1:p2' });
    const h = mkTempDir();
    sessionFile(h, T);
    const herdr = (): ReadonlyMap<string, HerdrAgent> => new Map([['w1:p2', { kind: 'claude', session: SID }]]);
    expect(taskActive('t1', lastLog, deps(h, herdr))?.source).toBe('session');
  });

  it('2: the pulse, when there is no session file', () => {
    Task.create('t1', 'x');
    const run = shift('s1', { agent_session: SID });
    writeFileSync(join(run, 'pulse'), `${T / 1000} ${T / 1000 + 60} abc\n`);
    writeFileSync(join(run, 'status'), '2026-09-18T11:00:00Z\tstarted\t\n');
    expect(taskActive('t1', lastLog, deps(mkTempDir()))).toEqual({ at: '2026-09-18T10:00:00Z', precision: 'second', source: 'pulse' });
  });

  it('3: the last line of run/status, when nothing sampled a pulse', () => {
    Task.create('t1', 'x');
    const run = shift('s1', {});
    writeFileSync(join(run, 'status'), '2026-09-18T08:00:00Z\tstarted\t\n2026-09-18T09:30:00Z\tdone\tmr x\n');
    expect(taskActive('t1', lastLog, deps(mkTempDir()))).toEqual({ at: '2026-09-18T09:30:00Z', precision: 'second', source: 'status' });
  });

  it('then the log, to the day, when no agent says anything', () => {
    Task.create('t1', 'x');
    shift('s1', {});
    expect(taskActive('t1', lastLog, deps(mkTempDir()))).toEqual(lastLog);
  });

  it('is the newest over every shift and the main agent', () => {
    Task.create('t1', 'x');
    writeFileSync(join(shift('s1', {}), 'status'), '2026-09-18T09:30:00Z\tdone\t\n');
    writeFileSync(join(shift('s2', {}), 'status'), '2026-09-18T09:45:00Z\tstarted\t\n');
    expect(taskActive('t1', lastLog, deps(mkTempDir()))?.at).toBe('2026-09-18T09:45:00Z');

    // A live main agent, the child of the process holding the enter lock.
    const h = mkTempDir();
    const lock = join(home, 'tasks', 't1', '.enter.lock');
    writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: Math.floor(T / 1000), identity: 'yan t1 pane=w1:p1' }));
    mkdirSync(join(h, '.claude', 'sessions'), { recursive: true });
    writeFileSync(join(h, '.claude', 'sessions', '777.json'), JSON.stringify({ pid: 777, sessionId: 'main-session', cwd: '/yan', startedAt: T }));
    const file = join(h, '.claude', 'projects', claudeProjectSlug('/yan'), 'main-session.jsonl');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '{}\n');
    utimesSync(file, T / 1000 + 7200, T / 1000 + 7200);
    const d: ActiveDeps = { ...deps(h), harness: { home: h, processes: () => new Map([[777, process.pid]]) } };
    expect(taskActive('t1', lastLog, d)).toEqual({ at: '2026-09-18T12:00:00Z', precision: 'second', source: 'session' });
  });
});
