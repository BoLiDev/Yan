import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
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
import { expectUsage } from '../helpers/usage.js';
import { Task } from '../../src/records/task/index.js';

/**
 * `yan tree`: the standing tree yan and `user` share for one unit, and the
 * return and status around it.
 *
 * What the shape is for: every value comes off task.json, so there is nothing
 * to get wrong, and the tree is checked out on the round's integration branch
 * rather than cutting a new branch beside it.
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

  it('is the only shape: the flags it once stood for are gone', async () => {
    for (const flag of ['--repo', '--base', '--branch', '--holder']) {
      const r = await yan(['get', '--unit', 'auth', flag, 'x'], { YAN_TASK: 't042' });
      expectUsage(r, `unknown option '${flag}'`);
    }
    expectUsage(await yan(['get'], { YAN_TASK: 't042' }), '--unit is required');
  });

  it('refuses a unit the task does not have', async () => {
    const nope = await yan(['get', '--unit', 'gateway'], { YAN_TASK: 't042' });
    expect(nope.code).toBe(2);
    expect(nope.out).toContain('no such unit');
  });
});

describe('return and status', () => {
  async function standing(): Promise<string> {
    const got = await yan(['get', '--unit', 'auth', '--json'], { YAN_TASK: 't042' });
    expect(got.code, got.out).toBe(0);
    return (JSON.parse(got.stdout) as { path: string }).path;
  }

  it('exits 3 on a refused conditional return, and 2 when called wrongly', async () => {
    const path = await standing();

    const refused = await yan(['return', '--repo', 'demo', '--path', path, '--if-lease-id', 'nope']);
    expect(refused.code).toBe(3);

    expectUsage(await yan(['return', '--repo', 'demo']), 'which tree?');
    expectUsage(await yan(['status', '--repo', 'nosuchrepo']), 'unknown repository');
  });

  it('will not discard work without being told `user` said so, and says the slot is still held', async () => {
    const path = await standing();
    writeFileSync(join(path, 'stray.txt'), 'uncommitted\n');

    // --discard on its own is the shape a retry would have, and a retry must
    // never be able to destroy this.
    const alone = await yan(['return', '--repo', 'demo', '--path', path, '--discard']);
    expectUsage(alone, '--user-asked');
    expect(existsSync(join(path, 'stray.txt')), 'and nothing was touched').toBe(true);

    // So is --user-asked with nothing to answer.
    expectUsage(await yan(['return', '--repo', 'demo', '--path', path, '--user-asked']), 'answers --discard');

    // The plain refusal names both ways out rather than dead-ending.
    const refused = await yan(['return', '--repo', 'demo', '--path', path]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('stray.txt');
    expect(refused.stderr).toContain('--discard --user-asked');

    // Together they release the slot, which is the whole point of the door.
    const discarded = await yan(['return', '--repo', 'demo', '--path', path, '--discard', '--user-asked']);
    expect(discarded.code, discarded.stderr).toBe(0);
    expect(existsSync(join(path, 'stray.txt'))).toBe(false);
    expect((await yan(['status', '--repo', 'demo'])).stdout).not.toContain('t042/auth');
  });
});

describe('pool_size', () => {
  it('is read off the registered name when the clone directory is called something else', async () => {
    // Registered as `yan`, cloned into `Yan-Dev`: the size has to come from
    // the registry entry, not from a lookup by the directory's name.
    const bare = await mkBareRemote(join(home, 'yan.git'));
    const other = await mkClone(bare, join(home, 'repos', 'Yan-Dev'));
    registerRepo(home, 'yan', other, { url: bare, pool_size: 3 });
    const task = new Task('t042');
    for (const unit of ['a', 'b', 'c', 'd']) {
      await fxGit(['branch', `yan/t042-${unit}-r1`, 'main'], other);
      task.addUnit(unit, 'yan', 'main', { branch: `yan/t042-${unit}-r1` });
    }

    expect((await yan(['status', '--repo', 'yan'])).stdout).toContain('0 of 3 trees leased');
    expect((await yan(['status', '--repo', other])).stdout, 'the clone path finds the same entry').toContain('0 of 3 trees leased');

    for (const unit of ['a', 'b', 'c']) {
      const got = await yan(['get', '--unit', unit], { YAN_TASK: 't042' });
      expect(got.code, got.out).toBe(0);
    }
    const fourth = await yan(['get', '--unit', 'd'], { YAN_TASK: 't042' });
    expect(fourth.code).not.toBe(0);
    expect(fourth.out).toContain('all 3 trees are leased');
  });
});
