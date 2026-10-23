import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkBareRemote, mkClone, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { progressLines, taskProgress } from './progress.js';
import { repoName } from './repo-name.js';
import { WorktreePool, returnTrees } from '../../externals/worktree/index.js';
import { register } from '../../records/repos/index.js';
import { Task } from '../../records/task/index.js';

afterAll(cleanupTempDirs);

let tree = '';
let bare = '';
let clone = '';

beforeEach(async () => {
  mkYanHome(mkTempDir());
  process.env.YAN_POOL_ROOT = mkTempDir('yan-pool-');
  bare = await mkBareRemote(join(mkTempDir(), 'web.git'));
  clone = await mkClone(bare, join(mkTempDir(), 'web'));
  Task.create('with a tree', [{ url: bare }]);
  tree = new WorktreePool(clone).get('origin/main', 't001').path;
});

afterEach(() => {
  delete process.env.YAN_POOL_ROOT;
});

async function commit(name: string): Promise<void> {
  writeFileSync(join(tree, name), `${name}\n`);
  await fxGit(['add', name], tree);
  await fxGit(['commit', '-m', name], tree);
}

describe('taskProgress', () => {
  it('reads the tree here: its branch, how far ahead of the default branch, what is unpushed and uncommitted', async () => {
    const [detached] = taskProgress(new Task('t001'));
    expect(detached).toMatchObject({ branch: null, ahead: 0, unpushed: 0, uncommitted: 0, tree });
    expect(detached?.detachedAt).toMatch(/^[0-9a-f]{7,}$/);

    await fxGit(['checkout', '-b', 'feat/x'], tree);
    await commit('a.txt');
    await commit('b.txt');
    await fxGit(['push', '-u', 'origin', 'feat/x'], tree);
    await commit('c.txt');
    writeFileSync(join(tree, 'loose.txt'), 'not added\n');

    const progress = taskProgress(new Task('t001'));
    expect(progress).toEqual([{
      repo: repoName(bare), url: bare, scope: [], branch: 'feat/x', detachedAt: null, earlierBranches: [], branches: [],
      tree, base: 'main', ahead: 3, unpushed: 1, uncommitted: 1,
    }]);
    expect(progressLines(progress)[0]).toBe(`  ${repoName(bare)}  feat/x  3 ahead of main · 1 not pushed · 1 uncommitted`);
  });

  it('says which packages a task in a monorepo is about, under its tree', () => {
    const task = Task.create('in a monorepo', [{ url: bare, scope: ['apps/site', 'packages/core'] }]);
    const [repo] = taskProgress(task);
    expect(repo?.scope).toEqual(['apps/site', 'packages/core']);
    expect(progressLines(taskProgress(task)).at(-1)?.trim()).toBe('about apps/site, packages/core');
  });

  it('lists the task\'s other branches by where each stands: merged by a merge commit, given up, or in progress', async () => {
    const task = new Task('t001');
    const cut = async (name: string, file?: string): Promise<void> => {
      await fxGit(['checkout', '-b', name, 'origin/main'], tree);
      if (file !== undefined) await commit(file);
      await fxGit(['push', '-u', 'origin', name], tree);
      task.keepBranch(bare, name);
    };
    await cut('feat/merged', 'm.txt');
    await cut('feat/fresh');
    await cut('feat/old', 'o.txt');
    await cut('feat/y', 'y.txt');
    await cut('feat/x', 'x.txt');
    task.abandonBranch(bare, 'feat/old');
    await fxGit(['merge', '--no-ff', '-m', 'Merge pull request #7 from me/feat/merged', 'origin/feat/merged'], clone);
    await fxGit(['push', 'origin', 'main'], clone);

    const progress = taskProgress(task);
    expect(progress[0]?.branches).toEqual([
      { name: 'feat/x', state: 'open' },
      { name: 'feat/y', state: 'open' },
      { name: 'feat/old', state: 'abandoned' },
      { name: 'feat/fresh', state: 'open' },
      { name: 'feat/merged', state: 'merged' },
    ]);
    const pad = ' '.repeat(repoName(bare).length + 4);
    expect(progressLines(progress).slice(2)).toEqual([
      `${pad}in progress: feat/y, feat/fresh`,
      `${pad}merged: feat/merged`,
      `${pad}abandoned: feat/old`,
    ]);
  });

  it('with no tree here, reads the branch the task keeps from the clone, as last fetched', async () => {
    await fxGit(['checkout', '-b', 'feat/x'], tree);
    await commit('a.txt');
    await fxGit(['push', '-u', 'origin', 'feat/x'], tree);
    const task = new Task('t001');
    task.keepBranch(bare, 'feat/x');
    await fxGit(['checkout', '--detach'], tree);
    returnTrees('t001');
    register('web', bare, clone);
    await fxGit(['fetch', 'origin'], clone);

    const progress = taskProgress(task);
    expect(progress[0]).toMatchObject({ branch: 'feat/x', tree: null, base: 'main', ahead: 1, unpushed: null, uncommitted: null });
    expect(progressLines(progress)).toEqual([
      '  web  feat/x  1 ahead of main on origin, as last fetched',
      '       no worktree on this machine',
    ]);
  });
});
