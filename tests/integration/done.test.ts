import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, giveOrigin, mkBareRemote, mkClone, mkTempDir, mkYanHome, onOrigin, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { WorktreePool, leasesHeldBy } from '../../src/externals/worktree/index.js';
import { Task } from '../../src/records/task/index.js';

/**
 * `yan done`: closing a task gives its tree back, and the tree's guard can
 * keep the task open.
 */

afterAll(cleanupTempDirs);

let home = '';
let pool = '';
let tree = '';
let bare = '';

function yan(args: readonly string[], env: Record<string, string | undefined> = {}) {
  return runYan(home, args, { YAN_POOL_ROOT: pool, ...env });
}

beforeEach(async () => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  pool = mkTempDir('yan-pool-');
  process.env.YAN_POOL_ROOT = pool;
  bare = await mkBareRemote(join(mkTempDir(), 'origin.git'));
  const clone = await mkClone(bare, join(mkTempDir(), 'demo'));
  // What a real repository ignores, so the tree can be warm and clean at once.
  writeFileSync(join(clone, '.git', 'info', 'exclude'), 'node_modules/\n');
  const task = Task.create('with a tree', [{ url: bare }]);
  tree = new WorktreePool(clone).get('origin/main', task.id).path;
  Task.create('without one');
});

afterEach(() => {
  delete process.env.YAN_POOL_ROOT;
});

describe('yan done', () => {
  it('closes a task with no tree', async () => {
    const r = await yan(['done', 't002']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout.trim()).toBe('t002  done');
    expect(new Task('t002').read().state).toBe('done');
  });

  it('returns a clean, pushed tree, warm, and closes the task', async () => {
    mkdirSync(join(tree, 'node_modules'), { recursive: true });
    writeFileSync(join(tree, 'node_modules', 'dep.js'), '');
    const r = await yan(['done'], { YAN_TASK: 't001' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('tree returned');
    expect(leasesHeldBy('t001')).toEqual([]);
    expect(existsSync(join(tree, 'node_modules', 'dep.js'))).toBe(true);
    expect(new Task('t001').read().state).toBe('done');
  });

  it('keeps the task open while its tree has work nowhere else, and --force throws it away', async () => {
    writeFileSync(join(tree, 'wip.txt'), 'half done\n');
    const refused = await yan(['done', 't001']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('wip.txt');
    expect(new Task('t001').read().state).toBe('open');
    expect(leasesHeldBy('t001')).toHaveLength(1);

    await fxGit(['add', '.'], tree);
    await fxGit(['commit', '-m', 'wip'], tree);
    expect((await yan(['done', 't001'])).stderr).toContain('no remote branch contains HEAD');

    const forced = await yan(['done', 't001', '--force']);
    expect(forced.code, forced.out).toBe(0);
    expect(new Task('t001').read().state).toBe('done');
  });

  it('abandons with a reason, and refuses an empty one', async () => {
    expectUsage(await yan(['done', 't002', '--abandon', ' ']), '--abandon takes the reason');
    const r = await yan(['done', 't002', '--abandon', 'not needed']);
    expect(r.stdout.trim()).toBe('t002  abandoned');
    expect(new Task('t002').read()).toMatchObject({ state: 'abandoned', reason: 'not needed' });
  });

  it('asks for the task when it has neither an argument nor a terminal', async () => {
    expectUsage(await yan(['done']), 'yan done <task-id>');
  });
});

describe('yan peek', () => {
  it('shows each of a task\'s trees with its scope, and a repository with no tree here', async () => {
    const web = await mkBareRemote(join(mkTempDir(), 'web.git'));
    const webClone = await mkClone(web, join(mkTempDir(), 'web'));
    const webTree = new WorktreePool(webClone).get('origin/main', 't001').path;
    const api = await mkBareRemote(join(mkTempDir(), 'api.git'));
    const task = new Task('t001');
    writeFileSync(task.file, JSON.stringify({
      ...task.read(),
      repos: [{ url: bare }, { url: web, scope: ['apps/site'] }, { url: api }],
    }));

    const r = await yan(['peek', 't001']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`│  \\S+ +\\S*${tree.split('/').slice(-3).join('/')}\\n│ +detached HEAD$`, 'm'));
    expect(r.stdout).toMatch(new RegExp(`│  web +\\S*${webTree.split('/').slice(-3).join('/')}\\n│ +detached HEAD\\n│ +about apps/site$`, 'm'));
    expect(r.stdout).toMatch(/│ {2}api +none on this machine$/m);
  });
});

describe('a task closed, paused or resumed at a terminal', () => {
  /** The task as origin has it. */
  async function there(origin: string, id: string): Promise<Record<string, unknown>> {
    return JSON.parse((await onOrigin(origin, `tasks/${id}/task.json`)) ?? '{}') as Record<string, unknown>;
  }

  it('is committed and pushed at once, so the other machines see it without an agent pushing it', async () => {
    const origin = await giveOrigin(home);

    expect((await yan(['pause', 't002'])).code).toBe(0);
    expect(await there(origin, 't002')).toMatchObject({ pausedAt: expect.any(String) });
    expect((await yan(['resume', 't002'])).code).toBe(0);
    expect((await there(origin, 't002')).pausedAt).toBeUndefined();
    expect((await yan(['done', 't002', '--abandon', 'the API was dropped'])).code).toBe(0);
    expect(await there(origin, 't002')).toMatchObject({ state: 'abandoned', reason: 'the API was dropped' });

    expect((await fxGit(['status', '--porcelain'], home)).stdout, 'nothing left uncommitted').toBe('');
  });

  it('is kept here, and said, when origin cannot be reached', async () => {
    const origin = await giveOrigin(home);
    await fxGit(['remote', 'set-url', 'origin', join(mkTempDir(), 'gone.git')], home);
    const paused = await yan(['pause', 't002']);
    expect(paused.code, 'paused all the same').toBe(0);
    expect(paused.stderr).toContain('not pushed');
    expect(new Task('t002').read().pausedAt).toBeDefined();
    expect((await there(origin, 't002')).pausedAt).toBeUndefined();
    expect((await fxGit(['status', '--porcelain'], home)).stdout, 'committed here for the next push').toBe('');
  });

  it('closed already, on another machine say, only has its tree here given back, and stays as it was closed', async () => {
    new Task('t001').close('abandoned', 'the API was dropped');
    const closed = new Task('t001').read();
    const r = await yan(['done', 't001']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('tree returned');
    expect(leasesHeldBy('t001')).toEqual([]);
    expect(new Task('t001').read()).toMatchObject({ state: 'abandoned', reason: 'the API was dropped', closedAt: closed.closedAt });
  });
});

describe('yan pause and yan resume', () => {
  it('puts a task aside: its tree goes back, warm, it keeps its state, and resume takes it up again as it was', async () => {
    new Task('t001').awaitUat();
    mkdirSync(join(tree, 'node_modules'), { recursive: true });
    writeFileSync(join(tree, 'node_modules', 'dep.js'), '');
    const paused = await yan(['pause'], { YAN_TASK: 't001' });
    expect(paused.code, paused.out).toBe(0);
    expect(paused.stdout).toContain('tree returned');
    expect(leasesHeldBy('t001')).toEqual([]);
    expect(existsSync(join(tree, 'node_modules', 'dep.js'))).toBe(true);
    expect(new Task('t001').read()).toMatchObject({ state: 'uat', pausedAt: expect.any(String) });

    const listed = JSON.parse((await yan(['ls', '--json'])).stdout) as { id: string; paused: boolean }[];
    expect(listed.find((r) => r.id === 't001')?.paused, 'still listed among the open ones, as paused').toBe(true);
    expectUsage(await yan(['pause', 't001']), 'paused already');

    const resumed = await yan(['resume', 't001']);
    expect(resumed.code, resumed.out).toBe(0);
    expect(new Task('t001').read().state, 'in review, as it was').toBe('uat');
    expect(new Task('t001').read().pausedAt).toBeUndefined();
    expect((await yan(['resume', 't001'])).stdout.trim()).toBe('t001 was not paused');
  });

  it('keeps a task open while its tree has work nowhere else, and refuses a closed one', async () => {
    writeFileSync(join(tree, 'wip.txt'), 'half done\n');
    const refused = await yan(['pause', 't001']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('wip.txt');
    expect(new Task('t001').read().pausedAt).toBeUndefined();
    expect(leasesHeldBy('t001')).toHaveLength(1);

    new Task('t002').close('done');
    expectUsage(await yan(['pause', 't002']), 'only an open task is paused');
  });
});
