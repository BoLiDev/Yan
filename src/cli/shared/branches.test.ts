import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkBareRemote, mkClone, mkCommit, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { branchStates, keepTreeBranches } from './branches.js';
import { repoName } from './repo-name.js';
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

describe('keepTreeBranches', () => {
  it('keeps the branch a tree is on, as origin names it, and only when it changed', async () => {
    expect(keepTreeBranches(), 'a detached HEAD keeps nothing').toEqual([]);

    await fxGit(['checkout', '-b', 'local-name'], tree);
    await fxGit(['push', '-u', 'origin', 'local-name:feat/remote-name'], tree);
    expect(keepTreeBranches()).toEqual([`kept branch feat/remote-name for ${repoName(bare)} → t001`]);
    expect(new Task('t001').read().repos).toEqual([{ url: bare, branch: 'feat/remote-name', branchMarks: { 'feat/remote-name': 'open' } }]);
    expect(keepTreeBranches(), 'nothing changed since').toEqual([]);

    await fxGit(['checkout', '-b', 'feat/next'], tree);
    expect(keepTreeBranches()).toEqual([`kept branch feat/next for ${repoName(bare)} → t001`]);
    expect(new Task('t001').read().repos[0]?.branchMarks, 'the one the tree left stays in progress').toEqual({ 'feat/remote-name': 'open', 'feat/next': 'open' });
  });

  it('notes where the branch last met main while it has commits of its own, so one fast-forwarded in still reads merged', async () => {
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
    keepTreeBranches();
    expect(task.read().repos[0]?.branchBases, 'just cut, nothing of its own: nothing noted').toBeUndefined();

    await mkCommit(tree, 'x.txt', 'x', 'x');
    keepTreeBranches();
    expect(task.read().repos[0]?.branchBases).toEqual({ 'feat/x': forkPoint });

    await mainMovesOn('m.txt');
    await fxGit(['merge', '-q', '--no-edit', 'origin/main'], tree);
    keepTreeBranches();
    const lastMet = await sha('origin/main');
    expect(task.read().repos[0]?.branchBases, 'main merged in moves it on').toEqual({ 'feat/x': lastMet });

    await fxGit(['push', '-q', 'origin', 'feat/x:main', 'feat/x'], tree);
    await fxGit(['fetch', '-q', 'origin'], tree);
    keepTreeBranches();
    const repo = task.read().repos[0] as TaskRepo;
    expect(repo.branchBases, 'fast-forwarded in: main has it all, the point stays').toEqual({ 'feat/x': lastMet });
    expect(branchStates(repo, tree)).toEqual([{ name: 'feat/x', state: 'merged' }]);

    // A branch with nothing of its own that catches up with main has only moved forward with it, never been merged.
    await fxGit(['checkout', '-q', '-b', 'feat/idle'], tree);
    keepTreeBranches();
    await mainMovesOn('n.txt');
    await fxGit(['merge', '-q', '--ff-only', 'origin/main'], tree);
    keepTreeBranches();
    const now = task.read().repos[0] as TaskRepo;
    expect(now.branchBases).toEqual({ 'feat/x': lastMet });
    expect(branchStates(now, tree)).toEqual([{ name: 'feat/idle', state: 'open' }, { name: 'feat/x', state: 'merged' }]);
  });

  it('keeps nothing for a closed task, or for a tree of a repository the task does not list', async () => {
    await fxGit(['checkout', '-b', 'feat/x'], tree);
    const task = new Task('t001');
    task.close('done');
    expect(keepTreeBranches()).toEqual([]);

    const other = Task.create('elsewhere', [{ url: 'git@github.com:me/api.git' }]);
    const otherClone = await mkClone(bare, join(mkTempDir(), 'web-again'));
    const otherTree = new WorktreePool(otherClone).get('origin/main', other.id).path;
    await fxGit(['checkout', '-b', 'feat/y'], otherTree);
    expect(keepTreeBranches()).toEqual([]);
    expect(task.read().repos[0]?.branch).toBeUndefined();
  });
});
