import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkClone,
  mkTempDir,
  mkYanHome,
  registerRepo,
  runYan,
  type RunResult,
} from '../helpers/fixtures.js';
import { Task } from '../../src/records/task/index.js';

/**
 * `yan tree get --unit <name>` — the standing tree yan and `user` share for
 * one unit, which the explicit four-flag form spells out by hand.
 *
 * What the shape is for: every value comes off task.json, so there is nothing
 * to get wrong, and both branch flags are the integration branch — the tree is
 * checked out on the round rather than cutting a new branch beside it.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let poolRoot = '';
let previousHome: string | undefined;

function yan(args: readonly string[], env: Record<string, string | undefined> = {}): Promise<RunResult> {
  return runYan(home, ['tree', ...args], { YAN_POOL_ROOT: poolRoot, ...env });
}

beforeEach(async () => {
  previousHome = process.env.YAN_HOME;
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  poolRoot = mkTempDir('yan-pool-');
  process.env.YAN_HOME = home;

  const bare = await mkBareRemote(join(tmp, 'origin.git'));
  clone = await mkClone(bare, join(home, 'repos', 'demo'));
  await fxGit(['branch', 'yan/t042-auth-r1', 'main'], clone);
  registerRepo(home, 'demo', clone, { url: bare, pool_size: 2 });

  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'demo', 'main', { branch: 'yan/t042-auth-r1' });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('the standing tree', () => {
  it('leases the unit\'s integration branch, held as <task>/<unit>', async () => {
    const got = await yan(['get', '--unit', 'auth'], { YAN_TASK: 't042' });
    expect(got.code, got.out).toBe(0);
    expect(got.stdout.trim()).not.toBe('');

    const status = await yan(['status', '--repo', 'demo']);
    expect(status.stdout).toContain('t042/auth');
    // The holder has no sid: no shift owns a standing tree.
    expect(status.stdout).not.toContain('t042/auth/');
    expect(status.stdout, 'checked out on the round, not on a branch beside it').toContain('yan/t042-auth-r1');
  });

  it('takes the task from the environment, and says so when there is none', async () => {
    const none = await yan(['get', '--unit', 'auth'], { YAN_TASK: undefined });
    expect(none.code).toBe(2);
    expect(none.out).toContain('$YAN_TASK is unset');
  });

  it('refuses --unit mixed with the flags it stands for', async () => {
    const both = await yan(['get', '--unit', 'auth', '--repo', 'demo'], { YAN_TASK: 't042' });
    expect(both.code).toBe(2);
    expect(both.out).toContain('alternatives');
  });

  it('refuses a unit the task does not have', async () => {
    const nope = await yan(['get', '--unit', 'gateway'], { YAN_TASK: 't042' });
    expect(nope.code).toBe(2);
    expect(nope.out).toContain('no such unit');
  });
});

describe('the explicit form, which shifts and tests use', () => {
  it('still cuts a new branch from a base', async () => {
    const got = await yan([
      'get', '--repo', 'demo', '--base', 'yan/t042-auth-r1', '--branch', 'yan/t042-auth-s1', '--holder', 't042/auth/s1',
    ]);
    expect(got.code, got.out).toBe(0);
    expect((await yan(['status', '--repo', 'demo'])).stdout).toContain('t042/auth/s1');
  });
});
