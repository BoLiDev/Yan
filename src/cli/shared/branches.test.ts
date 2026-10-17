import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkBareRemote, mkClone, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { keepTreeBranches } from './branches.js';
import { repoName } from './repo-name.js';
import { WorktreePool } from '../../externals/worktree/index.js';
import { Task } from '../../records/task/index.js';

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
    expect(new Task('t001').read().repos).toEqual([{ url: bare, branch: 'feat/remote-name' }]);
    expect(keepTreeBranches(), 'nothing changed since').toEqual([]);

    await fxGit(['checkout', '-b', 'feat/next'], tree);
    expect(keepTreeBranches()).toEqual([`kept branch feat/next for ${repoName(bare)} → t001`]);
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
