import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { snapshot, liveShift, seedT042 } from '../helpers/records.js';
import { Task } from '../../src/records/task/index.js';

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

beforeAll(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });


  // An empty home answers before anything exists.
  expect((await runYan(home, ['ls'])).stdout).toContain('no tasks yet — start one with yan task new');
  expect((await json<Queue>(['ls', '--json'])).tasks).toHaveLength(0);

  seedT042();
  new Task('t042').addUnit('gateway', 'monorepo-x', 'master', {
    branch: 'feat/gw', scope: ['apps/gateway'], needs: ['auth'],
  });

  Task.create('t007', 'retire the legacy client');
  new Task('t007').addUnit('client', 'service-y', 'release/2026.9', {
    branch: 'chore/retire', scope: ['src/client'],
  });
  new Task('t007').setComplete(true);

  // A live shift, which is run/meta.json existing and nothing else.
  treePath = join(tmp, 'trees', '1', 'monorepo-x').replace(/\\/g, '/');
  mkdirSync(treePath, { recursive: true });
  liveShift(home, 't042', 's3', { unit: 'auth', branch: 'yan/t042-auth-s3', tree: treePath, agent: 'claude' });

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
    expectUsage(await runYan(home, ['ls', '--status', 'closed']), "argument 'closed' is invalid");
  });

  it('is DERIVED: a task directory added by hand appears, with nothing told about it', async () => {
    Task.create('t900', 'a third task');

    expect((await json<Queue>(['ls', '--json', '--status', 'all'])).tasks).toHaveLength(3);
    rmSync(join(home, 'tasks', 't900'), { recursive: true, force: true });
    expect((await json<Queue>(['ls', '--json', '--status', 'all'])).tasks).toHaveLength(2);
  });
});

describe('a task missing its files', () => {
  it('still prints, in ls and in show, with a brief.md and a log.md gone', async () => {
    Task.create('t901', 'bare');
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
    expectUsage(await runYan(home, ['ls', 't042']), "too many arguments for 'ls'");
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
    expectUsage(await runYan(home, ['ls', 'nosuchtask']), "too many arguments for 'ls'");
    expectUsage(await runYan(home, ['ls', '--nope']), "unknown option '--nope'");
  });
});
