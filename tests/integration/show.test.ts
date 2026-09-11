import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  runYan,
} from '../helpers/fixtures.js';
import { enterIdentity } from '../../src/cli/shared/enter-lock.js';
import { tildePath } from '../../src/cli/shared/style.js';
import { WorktreePool } from '../../src/externals/worktree/index.js';
import { Log } from '../../src/records/log/index.js';
import { Task } from '../../src/records/task/index.js';
import type { ShowJson } from '../../src/cli/show.js';

/**
 * `yan show`: one task at a glance, from this machine alone. A real clone with
 * an integration branch two commits ahead of its target, a standing tree with
 * one uncommitted file, a live shift that last reported `blocked`, and a log
 * longer than what is shown.
 */

afterAll(cleanupTempDirs);

let home = '';
let poolRoot = '';
let tree = '';
let previousHome: string | undefined;
let previousPool: string | undefined;

async function show(args: readonly string[], env: Record<string, string | undefined> = {}) {
  return runYan(home, args, { YAN_POOL_ROOT: poolRoot, YAN_TASK: undefined, ...env });
}

function snapshot(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    found.push(full);
    if (statSync(full).isDirectory() && entry !== 'node_modules') found.push(...snapshot(full));
  }
  return found;
}

beforeAll(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  poolRoot = join(tmp, 'trees');
  previousHome = process.env.YAN_HOME;
  previousPool = process.env.YAN_POOL_ROOT;
  process.env.YAN_HOME = home;
  process.env.YAN_POOL_ROOT = poolRoot;

  const bare = await mkBareRemote(join(tmp, 'remote.git'));
  const clone = await mkClone(bare, join(home, 'repos', 'widget'));
  registerRepo(home, 'widget', clone, { url: bare });
  await fxGit(['-C', clone, 'checkout', '-b', 'feat/auth']);
  await mkCommit(clone, 'a.txt', 'a');
  await mkCommit(clone, 'b.txt', 'b');
  await fxGit(['-C', clone, 'push', '-u', 'origin', 'feat/auth']);
  await fxGit(['-C', clone, 'checkout', 'main']);

  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'widget', 'main', { branch: 'feat/auth', scope: ['apps/auth'] });
  writeFileSync(join(home, 'tasks', 't042', 'brief.md'), '# t042 unify the auth header\n\n## Goal\n\nOne parser for the auth header, at the edge.\n');
  const log = new Log('t042');
  for (let i = 1; i <= 7; i += 1) log.append('started', `entry ${i}`, '09-11');

  tree = new WorktreePool(clone).get(4, 'feat/auth', 'feat/auth', 't042/auth').path;
  writeFileSync(join(tree, 'wip.txt'), 'half done\n');

  const run = join(home, 'tasks', 't042', 'shifts', 's3', 'run');
  mkdirSync(run, { recursive: true });
  writeFileSync(
    join(run, 'meta.json'),
    JSON.stringify({ version: 1, unit: 'auth', branch: 'yan/t042-auth-s3', tree: '/trees/2', pane: 'w1:p4', scenario: 'coding', tier: 'normal' }),
  );
  writeFileSync(join(run, 'status'), `2026-09-11T08:00:00Z\tstarted\tread the brief\n${new Date().toISOString().slice(0, 19)}Z\tblocked\twhich header wins\n`);

  Task.create('t007', 'retire the legacy client');
  new Task('t007').setComplete(true);
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
  if (previousPool === undefined) delete process.env.YAN_POOL_ROOT;
  else process.env.YAN_POOL_ROOT = previousPool;
});

describe('one task at a glance', () => {
  it('shows the session, the branch, the tree, the shifts and the last five log entries', async () => {
    const r = await show(['show', 't042']);
    expect(r.code, r.out).toBe(0);
    const text = r.stdout;
    expect(text).toContain('t042  unify the auth header');
    expect(text).toContain('● open   ○ no yan running — resume with yan continue t042');
    expect(text, 'the brief is not shown').not.toContain('One parser');
    expect(text).toContain('auth  feat/auth → main   ↑2   mr');
    expect(text).toContain('scope  apps/auth');
    expect(text).toContain(`tree   ${tildePath(tree)}   ● 1 uncommitted`);
    expect(text).toContain('s3  coding/normal  blocked');
    expect(text).toContain('0m ago  which header wins');
    expect(text).toContain('w1:p4 · yan/t042-auth-s3');
    expect(text).toContain('Log  last 5 of 7');
    expect(text).toContain('entry 7');
    expect(text).toContain('entry 3');
    expect(text).not.toContain('entry 2');
  });

  it('says a unit has no standing tree, and a task has no live shift', async () => {
    new Task('t007').addUnit('client', 'widget', 'main', { branch: 'feat/auth' });
    const r = await show(['show', 't007']);
    expect(r.stdout).toContain('no standing tree');
    expect(r.stdout).toContain('none running');
    expect(r.stdout, 'a finished task is not one to continue').not.toContain('yan continue');
  });

  it('names the pane a running yan is in, and then does not suggest starting another', async () => {
    const lock = join(home, 'tasks', 't042', '.enter.lock');
    writeFileSync(lock, `${JSON.stringify({ pid: process.pid, host: hostname(), at: Math.floor(Date.now() / 1000), identity: enterIdentity('t042', 'w7:p1') })}\n`);
    try {
      const r = await show(['show', 't042']);
      expect(r.stdout).toContain('◉ yan running · w7:p1');
      expect(r.stdout).not.toContain('yan continue');
    } finally {
      rmSync(lock);
    }
  });

  it('gives the same facts as --json', async () => {
    const r = await show(['show', 't042', '--json']);
    expect(r.code, r.out).toBe(0);
    const j = JSON.parse(r.stdout) as ShowJson;
    expect(j.session).toEqual({ running: false, pane: null });
    expect(j.units[0]).toMatchObject({ name: 'auth', branch: 'feat/auth', target: 'main', ahead: 2, tree: { path: tree, dirty: 1 } });
    expect(j.shifts[0]).toMatchObject({ sid: 's3', scenario: 'coding', tier: 'normal', pane: 'w1:p4', last_event: { state: 'blocked', note: 'which header wins' } });
    expect(j.log.total).toBe(7);
    expect(j.log.lines).toHaveLength(5);
  });

  it('names entries written before they carried a type legacy, and lines them up', async () => {
    Task.create('t050', 'an old task');
    writeFileSync(
      join(home, 'tasks', 't050', 'log.md'),
      [
        '# t050 an old task',
        '',
        '- 08-30  auth  unit added',
        '- s1 dispatched: parse the header',
        'a paragraph that is not an entry',
        '- 08-31  agreed     one parser',
        '',
      ].join('\n'),
    );
    const r = await show(['show', 't050']);
    expect(r.code, r.out).toBe(0);
    const rows = r.stdout.split('\n');
    const column = (needle: string): number => (rows.find((l) => l.includes(needle)) ?? '').indexOf(needle);
    expect(column('s1 dispatched')).toBe(column('auth  unit added'));
    expect(column('one parser')).toBe(column('auth  unit added'));
    expect(r.stdout, 'no list marker survives').not.toContain('- s1 dispatched');
    expect(r.stdout, 'prose is not an entry').not.toContain('a paragraph');
    expect(r.stdout).toContain('last 3 of 3');
    expect(r.stdout).toContain('08-30  legacy     auth  unit added');
    expect(r.stdout).toContain('--     legacy     s1 dispatched');
  });

  it('is what yan ls <id> prints', async () => {
    expect((await show(['ls', 't042'])).stdout).toBe((await show(['show', 't042'])).stdout);
  });
});

describe('choosing, and refusing', () => {
  it('needs an id when there is no terminal to choose on', async () => {
    const r = await show(['show']);
    expect(r.code).toBe(2);
    expect(r.out).toContain("pass 'yan show <id>'");
  });

  it('refuses a task that does not exist', async () => {
    const r = await show(['show', 't404']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('no such task');
  });

  it('is plain text when it is not a terminal, and coloured when asked to be', async () => {
    const ESC = `${String.fromCharCode(27)}[`;
    expect((await show(['show', 't042'])).stdout).not.toContain(ESC);
    expect((await show(['show', 't042'], { FORCE_COLOR: '1' })).stdout).toContain(ESC);
    expect((await show(['show', 't042'], { FORCE_COLOR: '0' })).stdout).not.toContain(ESC);
  });

  it('writes nothing under the vault', async () => {
    const before = snapshot(home);
    await show(['show', 't042']);
    await show(['show', 't042', '--json']);
    expect(snapshot(home)).toEqual(before);
  });
});
