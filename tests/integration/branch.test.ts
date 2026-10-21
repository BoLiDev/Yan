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
  it('keeps the branch the worktree is on, as origin names it, and the one it moved from stays in progress', async () => {
    await fxGit(['checkout', '-b', 'local-name'], clone);
    await fxGit(['push', '-u', 'origin', 'local-name:feat/remote-name'], clone);
    const kept = await yan(['branch']);
    expect(kept.code).toBe(0);
    expect(kept.stdout.trim()).toBe('kept feat/remote-name for web, in progress → t001');
    expect(new Task('t001').read().repos).toEqual([{ url: bare, branch: 'feat/remote-name', branchMarks: { 'feat/remote-name': 'open' } }]);

    await fxGit(['checkout', '-b', 'feat/next'], clone);
    expect((await yan(['branch'])).stdout.trim()).toBe('kept feat/next for web, in progress → t001');
    expect(new Task('t001').read().repos).toEqual([{
      url: bare, branch: 'feat/next', earlierBranches: ['feat/remote-name'],
      branchMarks: { 'feat/remote-name': 'open', 'feat/next': 'open' },
    }]);
  });

  it('keeps a branch it is given, for a repository named anywhere', async () => {
    const elsewhere = mkTempDir();
    expect((await yan(['branch', 'feat/x', '--repo', 'web'], elsewhere)).stdout.trim()).toBe('kept feat/x for web, in progress → t001');
    expect(new Task('t001').read().repos[0]?.branch).toBe('feat/x');
    expect((await yan(['branch', 'keep', 'feat/y', '--repo', 'web'], elsewhere)).stdout.trim(), 'by its own name too').toBe('kept feat/y for web, in progress → t001');
  });

  it('marks a branch given up, from anywhere when the task has one repository, and says when it was already', async () => {
    new Task('t001').keepBranch(bare, 'feat/a');
    new Task('t001').keepBranch(bare, 'feat/b');
    const elsewhere = mkTempDir();
    const marked = await yan(['branch', 'abandon', 'feat/a'], elsewhere);
    expect(marked.code).toBe(0);
    expect(marked.stdout.trim()).toBe('feat/a in web marked abandoned → t001');
    expect((await yan(['branch', 'abandon', 'feat/a'])).stdout.trim()).toBe('feat/a in web was abandoned already → t001');
    expect(new Task('t001').read().repos[0]?.branchMarks).toEqual({ 'feat/a': 'abandoned', 'feat/b': 'open' });
    expectUsage(await yan(['branch', 'abandon', 'feat/z']), 'feat/z is not a branch of this task');
    expectUsage(await yan(['branch', 'abandon', 'feat/a', '--repo', 'api']), 'works in no repository called api');
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
