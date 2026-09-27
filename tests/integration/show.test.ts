import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostname } from 'node:os';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
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
import { expectUsage } from '../helpers/usage.js';
import { snapshot, liveShift, seedT042 } from '../helpers/records.js';
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
let previousPool: string | undefined;

async function show(args: readonly string[], env: Record<string, string | undefined> = {}) {
  return runYan(home, args, { YAN_POOL_ROOT: poolRoot, YAN_TASK: undefined, ...env });
}

beforeAll(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  poolRoot = join(tmp, 'trees');
  previousPool = process.env.YAN_POOL_ROOT;
  process.env.YAN_POOL_ROOT = poolRoot;

  const bare = await mkBareRemote(join(tmp, 'remote.git'));
  const clone = await mkClone(bare, join(home, 'repos', 'widget'));
  registerRepo(home, 'widget', clone, { url: bare });
  await fxGit(['-C', clone, 'checkout', '-b', 'feat/auth']);
  await mkCommit(clone, 'a.txt', 'a');
  await mkCommit(clone, 'b.txt', 'b');
  await fxGit(['-C', clone, 'push', '-u', 'origin', 'feat/auth']);
  await fxGit(['-C', clone, 'checkout', 'main']);

  seedT042({ repo: 'widget', target: 'main' });
  writeFileSync(join(home, 'tasks', 't042', 'brief.md'), '# t042 unify the auth header\n\n## Description\n\nThree services read the auth header\nthree ways.\n\nThe second paragraph.\n\n## Goal\n\nOne parser for the auth header, at the edge.\n');
  const log = new Log('t042');
  for (let i = 1; i <= 7; i += 1) log.append('started', `entry ${i}`, '09-11');

  tree = new WorktreePool(clone).get(4, 'feat/auth', 'feat/auth', 't042/auth').path;
  writeFileSync(join(tree, 'wip.txt'), 'half done\n');

  const run = liveShift(home, 't042', 's3', { unit: 'auth', branch: 'yan/t042-auth-s3', tree: '/trees/2', pane: 'w1:p4', scenario: 'coding', tier: 'normal' });
  writeFileSync(join(run, 'status'), `2026-09-11T08:00:00Z\tstarted\tread the brief\n${new Date().toISOString().slice(0, 19)}Z\tblocked\twhich header wins\n`);

  Task.create('t007', 'retire the legacy client');
  new Task('t007').setComplete(true);
});

afterAll(() => {
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
    expect(text, 'the whole Description, unwrapped').toContain('Three services read the auth header three ways.');
    expect(text).toContain('The second paragraph.');
    expect(text, 'and nothing else of the brief').not.toContain('One parser');
    expect(text).toContain('auth  feat/auth → main   ↑2');
    expect(text).toContain('scope  apps/auth');
    expect(text).toContain(`tree   ${tildePath(tree)}   ● 1 uncommitted`);
    expect(text).toContain('s3  coding/normal  blocked');
    expect(text, 'floored, so a report seconds old is now').toMatch(/blocked +now/);
    expect(text, "a shift's report note is not shown").not.toContain('which header wins');
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
      expect(r.stdout).toContain('● open   ◉ yan running');
      expect(r.stdout, 'the pane is for the main agent, in --json').not.toContain('w7:p1');
      expect(r.stdout).not.toContain('yan continue');
      const j = JSON.parse((await show(['show', 't042', '--json'])).stdout) as { session: unknown };
      expect(j.session).toEqual({ running: true, pane: 'w7:p1' });
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

  it('marks a shift a done task never clocked out, rather than counting it as running', async () => {
    Task.create('t051', 'a finished task');
    new Task('t051').setComplete(true);
    const run = liveShift(home, 't051', 's4', { unit: 'auth', branch: 'yan/t051-auth-s4', pane: 'w2:p3', scenario: 'uix', tier: 'normal' });
    writeFileSync(join(run, 'status'), ['2026-09-01T08:00:00Z', 'done', 'delivered'].join('\t') + '\n');

    const r = await show(['show', 't051']);
    expect(r.stdout).toContain('1 not clocked out');
    expect(r.stdout).not.toContain('running ·');
    expect(r.stdout).toContain('not clocked out');
    expect(r.stdout, 'where it ran would read as if it still were').not.toContain('w2:p3');
    expect((JSON.parse((await show(['show', 't051', '--json'])).stdout) as ShowJson).shifts[0]?.leftover).toBe(true);
    expect((JSON.parse((await show(['show', 't042', '--json'])).stdout) as ShowJson).shifts[0]?.leftover).toBe(false);
  });

  it('cuts a long log entry to the terminal, and keeps it whole for a pipe', async () => {
    Log.prototype.append.call(new Log('t042'), 'agreed', `a long decision ${'x'.repeat(120)} end`, '09-12');
    expect((await show(['show', 't042'])).stdout).toContain(' end');
    const narrow = await show(['show', 't042'], { COLUMNS: '60' });
    expect(narrow.stdout).not.toContain(' end');
    expect(narrow.stdout).toContain('a long decision x');
    expect(narrow.stdout).toContain('…');
  });

  it('is the only command that prints it: yan ls is the queue alone', async () => {
    const r = await show(['ls', 't042']);
    expectUsage(r, "too many arguments for 'ls'");
  });
});

describe('choosing, and refusing', () => {
  it('needs an id when there is no terminal to choose on', async () => {
    const r = await show(['show']);
    expectUsage(r, "'yan show <task-id>'");
  });

  it('falls back to the task this session is in', async () => {
    const r = await show(['show'], { YAN_TASK: 't042' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('unify the auth header');
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

describe('a shift that reported done on an open task', () => {
  it('is awaiting acceptance, not running', async () => {
    Task.create('t052', 'rounds of rework');
    const run = liveShift(home, 't052', 's2', { unit: 'auth', branch: 'yan/t052-auth-s2', pane: 'w5:p2', scenario: 'coding', tier: 'normal' });
    writeFileSync(join(run, 'status'), ['2026-09-11T08:00:00Z', 'done', 'mr https://forge.invalid/1'].join('\t') + '\n');

    const r = await show(['show', 't052']);
    expect(r.stdout).toContain('1 awaiting acceptance');
    expect(r.stdout).not.toContain('running ·');
    expect(r.stdout).toContain('awaiting acceptance   w5:p2 · yan/t052-auth-s2');
    expect((JSON.parse((await show(['show', 't052', '--json'])).stdout) as ShowJson).shifts[0]?.awaiting_acceptance).toBe(true);
  });
});

describe('reports that never reached yan', () => {
  /**
   * `run/undelivered` is what a shift writes when it could not type its note
   * into yan's pane. `yan show` is one of the two places it surfaces — and
   * only the task's own main agent clears it by reading it. `user` runs
   * `yan show` from their own pane constantly, and their shell carries no
   * $YAN_TASK; if that cleared the file, the report yan was meant to read
   * would be gone before yan ever ran.
   */
  const run = (): string => join(home, 'tasks', 't062', 'shifts', 's4', 'run');

  function seed(): void {
    liveShift(home, 't062', 's4', { unit: 'auth', pane: 'w6:p1', scenario: 'coding' }, '2026-09-11T08:00:00Z\tblocked\tneeds a credential\n');
    writeFileSync(join(run(), 'undelivered'), '2025-09-11T08:00:00Z\tblocked\tthe auth fixture needs a credential\n2025-09-11T08:01:40Z\tconflict\tsrc/cli/state.ts conflicts\n');
  }

  function kept(): boolean {
    return existsSync(join(run(), 'undelivered'));
  }

  it("prints them to user's own shell, which carries no task, and keeps them", async () => {
    Task.create('t062', 'undelivered reports');
    seed();

    const r = await show(['show', 't062']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('Undelivered reports');
    expect(r.stdout).toContain('the auth fixture needs a credential');
    expect(r.stdout, 'and says why they are still there').toContain("not this task's yan");
    expect(kept(), 'user glancing at a task must not swallow its reports').toBe(true);
  });

  it('keeps them for the yan of a different task, too', async () => {
    const r = await show(['show', 't062'], { YAN_TASK: 't042' });
    expect(r.stdout).toContain('the auth fixture needs a credential');
    expect(r.stdout).toContain("not this task's yan");
    expect(kept()).toBe(true);
  });

  it('keeps them for a shift, whose $YAN_TASK is its own task', async () => {
    const r = await show(['show', 't062'], { YAN_TASK: 't062', YAN_SID: 's4' });
    expect(r.stdout).toContain('the auth fixture needs a credential');
    expect(kept(), 'a shift reading the task picture is not the reader they were for').toBe(true);
  });

  it("prints every line to the task's own yan, then removes the file", async () => {
    const r = await show(['show', 't062'], { YAN_TASK: 't062' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('Undelivered reports');
    expect(r.stdout).toContain('the auth fixture needs a credential');
    expect(r.stdout).toContain('src/cli/state.ts conflicts');
    expect(r.stdout, 'the shift is named, since it is how yan answers').toContain('s4');
    expect(r.stdout, 'and the heading does not say they were kept').not.toContain("not this task's yan");
    expect(kept(), 'printed is said').toBe(false);

    const again = await show(['show', 't062'], { YAN_TASK: 't062' });
    expect(again.stdout, 'and it is not said twice').not.toContain('Undelivered reports');
  });

  it('carries them into --json, and clears them there on the same rule', async () => {
    seed();
    const asUser = JSON.parse((await show(['show', 't062', '--json'])).stdout) as ShowJson;
    expect(asUser.shifts[0]?.undelivered).toHaveLength(2);
    expect(kept(), '--json is a read like any other').toBe(true);

    const asYan = JSON.parse((await show(['show', 't062', '--json'], { YAN_TASK: 't062' })).stdout) as ShowJson;
    expect(asYan.shifts[0]?.undelivered).toEqual([
      { at: '2025-09-11T08:00:00Z', state: 'blocked', note: 'the auth fixture needs a credential' },
      { at: '2025-09-11T08:01:40Z', state: 'conflict', note: 'src/cli/state.ts conflicts' },
    ]);
    expect(kept()).toBe(false);
  });

  it('says nothing at all when there are none', async () => {
    const r = await show(['show', 't042']);
    expect(r.stdout).not.toContain('Undelivered');
  });
});
