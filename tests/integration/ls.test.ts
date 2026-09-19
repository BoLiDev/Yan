import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';

/**
 * `yan ls`.
 *
 * The assertion that matters most is the last: `yan ls` stores nothing, so
 * everything under `$YAN_HOME` is listed before and after and compared.
 */

afterAll(cleanupTempDirs);

let home = '';
let treePath = '';

interface Queue {
  version: number;
  status: string;
  hidden: { open: number; done: number };
  tasks: {
    id: string;
    title: string;
    state: string;
    description: string | null;
    opened: { at: string; precision: string; source: string } | null;
    closed: { at: string; precision: string } | null;
    changed: { state: string } | null;
    active: { at: string; precision: string; source: string } | null;
  }[];
}

async function json<T>(args: readonly string[]): Promise<T> {
  const r = await runYan(home, args);
  expect(r.code, r.out).toBe(0);
  return JSON.parse(r.stdout) as T;
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    out.push(full);
    if (statSync(full).isDirectory()) out.push(...snapshot(full));
  }
  return out;
}

beforeAll(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });

  const previous = process.env.YAN_HOME;
  process.env.YAN_HOME = home;
  const { Task } = await import('../../src/records/task/index.js');

  // An empty home answers before anything exists.
  expect((await runYan(home, ['ls'])).stdout).toContain('no tasks yet — start one with yan task new');
  expect((await json<Queue>(['ls', '--json'])).tasks).toHaveLength(0);

  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'monorepo-x', 'master', { branch: 'feat/auth', scope: ['apps/auth'] });
  new Task('t042').addUnit('gateway', 'monorepo-x', 'master', {
    branch: 'feat/gw', scope: ['apps/gateway'], needs: ['auth'],
  });

  Task.create('t007', 'retire the legacy client');
  new Task('t007').addUnit('client', 'service-y', 'release/2026.9', {
    branch: 'chore/retire', scope: ['src/client'],
  });
  new Task('t007').setComplete(true);
  if (previous === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previous;

  // A live shift, which is run/meta.json existing and nothing else.
  treePath = join(tmp, 'trees', '1', 'monorepo-x').replace(/\\/g, '/');
  mkdirSync(treePath, { recursive: true });
  mkdirSync(join(home, 'tasks', 't042', 'shifts', 's3', 'run'), { recursive: true });
  writeFileSync(
    join(home, 'tasks', 't042', 'shifts', 's3', 'run', 'meta.json'),
    `${JSON.stringify({ version: 1, unit: 'auth', branch: 'yan/t042-auth-s3', tree: treePath, agent: 'claude' }, null, 2)}\n`,
  );

  // A clocked-out shift keeps brief.md and outcome.md but no run/, so it must
  // not show up as live.
  mkdirSync(join(home, 'tasks', 't042', 'shifts', 's1'), { recursive: true });
  writeFileSync(join(home, 'tasks', 't042', 'shifts', 's1', 'outcome.md'), 'done\n');
});

describe('the queue', () => {
  it('renders the open tasks by default, and every task with --status all', async () => {
    const r = await runYan(home, ['ls']);
    expect(r.code, r.out).toBe(0);
    for (const needle of [
      ' t042  unify the auth header',
      'no description in brief.md',
      'changed unknown',
      '1 done hidden · yan ls --status=all',
    ]) {
      expect(r.stdout, needle).toContain(needle);
    }
    expect(r.stdout, 'a done task is hidden by default').not.toContain('t007');
    expect(r.stdout, 'a pipe gets no colour').not.toContain('\x1b[');
    expect(r.stdout.split('\n').filter((l) => / $/.test(l)), 'no line ends in spaces').toEqual([]);

    const all = await runYan(home, ['ls', '--status=all']);
    for (const needle of [' Open  1', ' Done  1', 't042', ' t007  retire the legacy client']) {
      expect(all.stdout, needle).toContain(needle);
    }
    expect(all.stdout, 'nothing is hidden').not.toContain('hidden');
    const done = await runYan(home, ['ls', '--status', 'done']);
    expect(done.stdout).toContain('t007');
    expect(done.stdout).not.toContain('t042');
    expect(done.stdout).toContain('1 open hidden · yan ls');
  });

  it('prints the overview as --json, version 2, filtered the same way', async () => {
    const q = await json<Queue>(['ls', '--json']);
    expect(q.version).toBe(2);
    expect(q.status).toBe('open');
    expect(q.hidden).toEqual({ open: 0, done: 1 });
    expect(q.tasks.map((t) => t.id)).toEqual(['t042']);
    const t042 = q.tasks[0];
    expect(t042?.state).toBe('open');
    expect(t042?.title).toBe('unify the auth header');
    expect(t042?.description).toBeNull();
    expect(t042?.opened?.precision).toBe('second');
    expect(t042?.closed).toBeNull();
    expect(t042?.changed, 'monorepo-x is not linked in this fixture').toEqual({ state: 'unknown' });
    expect(t042?.active, 'the live shift has nothing to read, and the log is empty').toBeNull();
    expect(Object.keys(t042 ?? {}), 'units, scope and shifts are yan show --json').not.toContain('units');

    const all = await json<Queue>(['ls', '--json', '--status', 'all']);
    const t007 = all.tasks.find((t) => t.id === 't007');
    expect(t007?.state).toBe('done');
    expect(t007?.closed?.precision).toBe('second');
    expect(t007?.changed).toBeNull();
    expect(all.hidden).toEqual({ open: 0, done: 0 });
  });

  it('refuses a status it does not know', async () => {
    expect((await runYan(home, ['ls', '--status', 'closed'])).code).toBe(2);
  });

  it('is DERIVED: a task directory added by hand appears, with nothing told about it', async () => {
    const previous = process.env.YAN_HOME;
    process.env.YAN_HOME = home;
    const { Task } = await import('../../src/records/task/index.js');
    Task.create('t900', 'a third task');
    if (previous === undefined) delete process.env.YAN_HOME;
    else process.env.YAN_HOME = previous;

    expect((await json<Queue>(['ls', '--json', '--status', 'all'])).tasks).toHaveLength(3);
    rmSync(join(home, 'tasks', 't900'), { recursive: true, force: true });
    expect((await json<Queue>(['ls', '--json', '--status', 'all'])).tasks).toHaveLength(2);
  });
});

describe('a task missing its files', () => {
  it('still prints, in ls and in show, with a brief.md and a log.md gone', async () => {
    const previous = process.env.YAN_HOME;
    process.env.YAN_HOME = home;
    const { Task } = await import('../../src/records/task/index.js');
    Task.create('t901', 'bare');
    if (previous === undefined) delete process.env.YAN_HOME;
    else process.env.YAN_HOME = previous;
    for (const file of ['brief.md', 'log.md']) rmSync(join(home, 'tasks', 't901', file), { force: true });
    try {
      for (const args of [['ls'], ['ls', '--status', 'all'], ['show', 't901']]) {
        const r = await runYan(home, args);
        expect(r.code, `${args.join(' ')}: ${r.out}`).toBe(0);
        expect(r.stdout).toContain('t901');
      }
    } finally {
      rmSync(join(home, 'tasks', 't901'), { recursive: true, force: true });
    }
  });
});

describe('one task is yan show, and only yan show', () => {
  // Two commands printing the same page is two commands to keep in step.
  it('refuses an id rather than printing the task', async () => {
    const r = await runYan(home, ['ls', 't042']);
    expect(r.code).toBe(2);
  });
});

describe('nothing is stored', () => {
  it('creates not one file anywhere under $YAN_HOME', async () => {
    const before = snapshot(home);
    await runYan(home, ['ls']);
    await runYan(home, ['ls', '--json']);
    await runYan(home, ['ls', '--json', '--status', 'all']);
    expect(snapshot(home)).toEqual(before);
  });

  it('and there is nowhere it could hide one', () => {
    for (const path of [['mem', 'backlog.json'], ['tasks', 'backlog.json'], ['mem', 'queue.json']]) {
      expect(existsSync(join(home, ...path)), path.join('/')).toBe(false);
    }
  });
});

describe('errors', () => {
  it('refuses an argument and an unknown option alike', async () => {
    expect((await runYan(home, ['ls', 'nosuchtask'])).code).toBe(2);
    expect((await runYan(home, ['ls', '--nope'])).code).toBe(2);
  });
});
