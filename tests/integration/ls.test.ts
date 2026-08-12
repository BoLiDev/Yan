import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';

/**
 * `yan ls`.
 *
 * The assertion that matters most is the last: `yan ls` stores nothing. There is no
 * backlog file and there must never be one - the queue is a
 * view produced by scanning `tasks/*​/task.json` every time it is asked for. It
 * is asserted the only way that really proves it: list everything under
 * `$YAN_HOME` before and after, and require the two to be identical.
 */

afterAll(cleanupTempDirs);

let home = '';
let treePath = '';

interface Queue {
  version: number;
  tasks: { id: string; title: string; complete: boolean; units: unknown[]; scope: string[]; shifts: number }[];
}

interface Detail {
  units: Record<string, unknown>[];
  shifts: { sid: string; unit: string; branch: string; tree: string }[];
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
  expect((await runYan(home, ['ls'])).stdout).toContain('no tasks');
  expect((await json<Queue>(['ls', '--json'])).tasks).toHaveLength(0);

  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'monorepo-x', 'master', { branch: 'feat/auth', scope: ['apps/auth'] });
  new Task('t042').addUnit('gateway', 'monorepo-x', 'master', {
    branch: 'feat/gw', scope: ['apps/gateway'], needs: ['auth'],
  });

  Task.create('t007', 'retire the legacy client');
  new Task('t007').addUnit('client', 'service-y', 'release/2026.9', {
    branch: 'chore/retire', scope: ['src/client'], mode: 'branch',
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
  it('renders every task, its state, and the scopes its units restrict', async () => {
    const r = await runYan(home, ['ls']);
    expect(r.code, r.out).toBe(0);
    for (const needle of ['t042', 't007', 'unify the auth header', 'apps/auth', 'apps/gateway', 'src/client', 'SCOPE', 'open', 'done']) {
      expect(r.stdout, needle).toContain(needle);
    }
  });

  it('reports the same facts as --json', async () => {
    const q = await json<Queue>(['ls', '--json']);
    expect(q.version).toBe(1);
    expect(q.tasks).toHaveLength(2);
    const t042 = q.tasks.find((t) => t.id === 't042');
    const t007 = q.tasks.find((t) => t.id === 't007');
    expect(t042?.complete).toBe(false);
    expect(t007?.complete).toBe(true);
    expect(t042?.units).toHaveLength(2);
    expect(t042?.shifts).toBe(1);
    expect(t007?.shifts).toBe(0);
    expect(t042?.scope).toEqual(['apps/auth', 'apps/gateway']);
  });

  it('is DERIVED: a task directory added by hand appears, with nothing told about it', async () => {
    const previous = process.env.YAN_HOME;
    process.env.YAN_HOME = home;
    const { Task } = await import('../../src/records/task/index.js');
    Task.create('t900', 'a third task');
    if (previous === undefined) delete process.env.YAN_HOME;
    else process.env.YAN_HOME = previous;

    expect((await json<Queue>(['ls', '--json'])).tasks).toHaveLength(3);
    rmSync(join(home, 'tasks', 't900'), { recursive: true, force: true });
    expect((await json<Queue>(['ls', '--json'])).tasks).toHaveLength(2);
  });
});

describe('one task: its units and its live shifts', () => {
  it('renders the branches, the targets and the worktree', async () => {
    const r = await runYan(home, ['ls', 't042']);
    expect(r.code, r.out).toBe(0);
    for (const needle of ['unify the auth header', 'feat/auth', 'feat/gw', 'master', 'apps/auth', 'yan/t042-auth-s3', treePath]) {
      expect(r.stdout, needle).toContain(needle);
    }
  });

  it('lists only the shift whose run/ is still there', async () => {
    const d = await json<Detail>(['ls', 't042', '--json']);
    expect(d.units).toHaveLength(2);
    expect(d.shifts).toHaveLength(1);
    expect(d.shifts[0]?.sid).toBe('s3');
    expect(d.shifts[0]?.unit).toBe('auth');
    expect(d.shifts[0]?.branch).toBe('yan/t042-auth-s3');
    expect(d.shifts[0]?.tree).toBe(treePath);

    const gateway = d.units.find((u) => u.name === 'gateway');
    expect(gateway?.scope).toEqual(['apps/gateway']);
    expect(gateway?.needs).toEqual(['auth']);
  });

  it('says so when a task has no live shift', async () => {
    expect((await runYan(home, ['ls', 't007'])).stdout).toContain('(none)');
  });
});

describe('nothing is stored', () => {
  it('creates not one file anywhere under $YAN_HOME', async () => {
    const before = snapshot(home);
    await runYan(home, ['ls']);
    await runYan(home, ['ls', '--json']);
    await runYan(home, ['ls', 't042']);
    await runYan(home, ['ls', 't042', '--json']);
    expect(snapshot(home)).toEqual(before);
  });

  it('and there is nowhere it could hide one', () => {
    for (const path of [['mem', 'backlog.json'], ['tasks', 'backlog.json'], ['mem', 'queue.json']]) {
      expect(existsSync(join(home, ...path)), path.join('/')).toBe(false);
    }
  });
});

describe('errors', () => {
  it('refuses an unknown task, two ids and an unknown option', async () => {
    const missing = await runYan(home, ['ls', 'nosuchtask']);
    expect(missing.code).not.toBe(0);
    expect(missing.out).toContain('no such task');

    expect((await runYan(home, ['ls', 't042', 't007'])).code).not.toBe(0);
    expect((await runYan(home, ['ls', '--nope'])).code).toBe(2);
  });
});
