import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkBareRemote, mkClone, mkCommit, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { branchStates, noteBranchBases } from './branches.js';
import { WorktreePool } from '../../externals/worktree/index.js';
import { Task, type TaskRepo } from '../../records/task/index.js';

afterAll(cleanupTempDirs);

let tree = '';
let bare = '';

beforeEach(async () => {
  mkYanHome(mkTempDir());
  process.env.YAN_POOL_ROOT = mkTempDir('yan-pool-');
  bare = await mkBareRemote(join(mkTempDir(), 'web.git'));
  const clone = await mkClone(bare, join(mkTempDir(), 'web'));
  Task.create('with a tree', [{ url: bare }]);
  tree = new WorktreePool(clone).get('origin/main', 't001').path;
});

afterEach(() => {
  delete process.env.YAN_POOL_ROOT;
});

describe('noteBranchBases', () => {
  it('keeps no branch: which branches are the task\'s is the agent\'s to say', async () => {
    await fxGit(['checkout', '-b', 'feat/scratch'], tree);
    await mkCommit(tree, 's.txt', 's', 'scratch');
    noteBranchBases();
    expect(new Task('t001').read().repos).toEqual([{ url: bare }]);
  });

  it('notes where a kept branch last met main while it has commits of its own, so one fast-forwarded in still reads merged', async () => {
    const task = new Task('t001');
    const sha = async (ref: string): Promise<string> => (await fxGit(['rev-parse', ref], tree)).stdout.trim();
    const mainMovesOn = async (file: string): Promise<void> => {
      const other = await mkClone(bare, join(mkTempDir(), 'other'));
      await mkCommit(other, file, file, `main gets ${file}`);
      await fxGit(['push', '-q', 'origin', 'main'], other);
      await fxGit(['fetch', '-q', 'origin'], tree);
    };
    const forkPoint = await sha('origin/main');
    await fxGit(['checkout', '-q', '-b', 'feat/x'], tree);
    task.keepBranch(bare, 'feat/x');
    noteBranchBases();
    expect(task.read().repos[0]?.branchBases, 'just cut, nothing of its own: nothing noted').toBeUndefined();

    await mkCommit(tree, 'x.txt', 'x', 'x');
    noteBranchBases();
    expect(task.read().repos[0]?.branchBases).toEqual({ 'feat/x': forkPoint });

    await mainMovesOn('m.txt');
    await fxGit(['merge', '-q', '--no-edit', 'origin/main'], tree);
    noteBranchBases();
    const lastMet = await sha('origin/main');
    expect(task.read().repos[0]?.branchBases, 'main merged in moves it on').toEqual({ 'feat/x': lastMet });

    await fxGit(['push', '-q', 'origin', 'feat/x:main', 'feat/x'], tree);
    await fxGit(['fetch', '-q', 'origin'], tree);
    noteBranchBases();
    const repo = task.read().repos[0] as TaskRepo;
    expect(repo.branchBases, 'fast-forwarded in: main has it all, the point stays').toEqual({ 'feat/x': lastMet });
    expect(branchStates(repo, tree)).toEqual([{ name: 'feat/x', state: 'merged' }]);

    // A branch with nothing of its own that catches up with main has only moved forward with it, never been merged.
    await fxGit(['checkout', '-q', '-b', 'feat/idle'], tree);
    task.keepBranch(bare, 'feat/idle');
    noteBranchBases();
    await mainMovesOn('n.txt');
    await fxGit(['merge', '-q', '--ff-only', 'origin/main'], tree);
    noteBranchBases();
    const now = task.read().repos[0] as TaskRepo;
    expect(now.branchBases).toEqual({ 'feat/x': lastMet });
    expect(branchStates(now, tree)).toEqual([{ name: 'feat/idle', state: 'open' }, { name: 'feat/x', state: 'merged' }]);
  });

  it('notes nothing for a branch the task does not keep, or for a closed task', async () => {
    const task = new Task('t001');
    task.keepBranch(bare, 'feat/kept');
    await fxGit(['checkout', '-q', '-b', 'feat/other'], tree);
    await mkCommit(tree, 'o.txt', 'o', 'o');
    noteBranchBases();
    expect(task.read().repos[0]?.branchBases, 'not one of the task\'s').toBeUndefined();

    task.keepBranch(bare, 'feat/other');
    task.close('done');
    noteBranchBases();
    expect(task.read().repos[0]?.branchBases).toBeUndefined();
  });
});
