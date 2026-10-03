import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkBareRemote, mkClone, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { Task } from '../../src/records/task/index.js';

/**
 * `yan branch` through `bin/yan.mjs`, run in a clone as the agent runs it in
 * its worktree: what it keeps, and what it refuses.
 */

afterAll(cleanupTempDirs);

let home = '';
let bare = '';
let clone = '';

function yan(args: readonly string[], cwd = clone) {
  return runYan(home, args, { YAN_TASK: 't001' }, cwd);
}

beforeEach(async () => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  bare = await mkBareRemote(join(mkTempDir(), 'web.git'));
  clone = await mkClone(bare, join(mkTempDir(), 'web'));
  Task.create('the first task', [{ url: bare }]);
});

describe('yan branch', () => {
  it('keeps the branch the worktree is on, as origin names it, and replaces it when the work moves', async () => {
    await fxGit(['checkout', '-b', 'local-name'], clone);
    await fxGit(['push', '-u', 'origin', 'local-name:feat/remote-name'], clone);
    const kept = await yan(['branch']);
    expect(kept.code).toBe(0);
    expect(kept.stdout.trim()).toBe('kept feat/remote-name for web → t001');
    expect(new Task('t001').read().repos).toEqual([{ url: bare, branch: 'feat/remote-name' }]);

    await fxGit(['checkout', '-b', 'feat/next'], clone);
    expect((await yan(['branch'])).stdout.trim()).toBe('replaced feat/remote-name with feat/next for web → t001');
  });

  it('keeps a branch it is given, for a repository named anywhere', async () => {
    const elsewhere = mkTempDir();
    expect((await yan(['branch', 'feat/x', '--repo', 'web'], elsewhere)).stdout.trim()).toBe('kept feat/x for web → t001');
    expect(new Task('t001').read().repos[0]?.branch).toBe('feat/x');
  });

  it('refuses a detached HEAD, the default branch, and a repository the task does not work in', async () => {
    await fxGit(['checkout', '--detach'], clone);
    expectUsage(await yan(['branch']), 'detached HEAD');
    await fxGit(['checkout', 'main'], clone);
    expectUsage(await yan(['branch']), "main is origin's default branch");
    expectUsage(await yan(['branch'], mkTempDir()), 'pass --repo <name>');
    expectUsage(await yan(['branch', 'feat/x', '--repo', 'api']), 'works in no repository called api - it works in web');
    expect(new Task('t001').read().repos).toEqual([{ url: bare }]);
  });
});
