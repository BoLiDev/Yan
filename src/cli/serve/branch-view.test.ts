import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkBareRemote, mkClone, mkCommit, mkTempDir } from '../../../tests/helpers/fixtures.js';
import { Branches, changedFiles, githubBase, isBranchName, prOf } from './branch-view.js';

/**
 * A task's branch against real git: a local bare remote, a clone where the
 * work is done and pushed, and the clone this machine keeps, which only the
 * server fetches into. No network.
 */

afterAll(cleanupTempDirs);

describe('reading git', () => {
  it('pairs each changed file with its line counts, renames included', () => {
    const nameStatus = ['M', 'a.ts', 'R087', 'old/b.ts', 'new/b.ts', 'A', 'img.png', ''].join('\0');
    const numstat = ['3\t1\ta.ts', '2\t2\t', 'old/b.ts', 'new/b.ts', '-\t-\timg.png', ''].join('\0');
    expect(changedFiles(nameStatus, numstat)).toEqual([
      { path: 'a.ts', from: null, status: 'M', add: 3, del: 1 },
      { path: 'new/b.ts', from: 'old/b.ts', status: 'R', add: 2, del: 2 },
      { path: 'img.png', from: null, status: 'A', add: null, del: null },
    ]);
  });

  it('finds the pull request in what GitHub calls a merge or a squash', () => {
    expect(prOf('Merge pull request #79 from BoLiDev/yan/t137-ipad')).toBe(79);
    expect(prOf('make the page wider (#12)')).toBe(12);
    expect(prOf("Merge branch 'x'")).toBeNull();
  });

  it('takes only names a refspec can carry, and links only GitHub', () => {
    expect(isBranchName('yan/t137-ipad')).toBe(true);
    expect(isBranchName('-x')).toBe(false);
    expect(isBranchName('a..b')).toBe(false);
    expect(isBranchName('a b')).toBe(false);
    expect(githubBase('git@github.com:BoLiDev/df-blade.git')).toBe('https://github.com/BoLiDev/df-blade');
    expect(githubBase('https://gitlab.com/a/b.git')).toBeNull();
  });
});

describe('a branch', () => {
  let bare = '';
  let work = '';
  let mine = '';
  let forkPoint = '';

  beforeAll(async () => {
    const root = mkTempDir('yan-serve-branch-');
    bare = await mkBareRemote(join(root, 'remote.git'));
    work = await mkClone(bare, join(root, 'work'));
    mine = await mkClone(bare, join(root, 'mine'));
    forkPoint = (await fxGit(['rev-parse', 'HEAD'], work)).stdout.trim();
    await fxGit(['checkout', '-q', '-b', 'feat/a'], work);
    await mkCommit(work, 'new.txt', 'new', 'add new.txt');
    await mkCommit(work, 'README.md', 'changed readme', 'change the readme');
    await fxGit(['push', '-q', '-u', 'origin', 'feat/a'], work);
    await fxGit(['checkout', '-q', 'main'], work);
    await mkCommit(work, 'other.txt', 'other', 'main moves on');
    await fxGit(['push', '-q', 'origin', 'main'], work);
  });

  it('is compared with where it left main, fetched into refs of the server own', async () => {
    const branches = new Branches(0);
    try {
      const b = await branches.view(bare, 'feat/a', mine);
      expect(b.missing).toBeNull();
      expect(b.merged).toBeNull();
      expect(b.base).toBe(forkPoint);
      expect([b.ahead, b.behind, b.target]).toEqual([2, 1, 'main']);
      expect(b.commits.map((c) => c.subject)).toEqual(['change the readme', 'add new.txt']);
      expect(b.files.map((f) => `${f.status} ${f.path} +${f.add} -${f.del}`)).toEqual(['M README.md +1 -1', 'A new.txt +1 -0']);
      // Nothing of anyone else's moved: no branch, and origin/feat/a only as `git fetch` would have made it.
      expect((await fxGit(['branch', '--list'], mine)).stdout.trim()).toBe('* main');
      expect((await fxGit(['for-each-ref', '--format=%(refname)', 'refs/yan/serve'], mine)).stdout.trim().split('\n').sort()).toEqual([
        'refs/yan/serve/heads/feat/a',
        'refs/yan/serve/heads/main',
      ]);
    } finally {
      await branches.close();
    }
  });

  it('once merged and deleted from origin, still shows what it changed, from its merge commit', async () => {
    await fxGit(['merge', '-q', '--no-ff', '-m', 'Merge pull request #5 from me/feat/a', 'origin/feat/a'], work);
    await fxGit(['push', '-q', 'origin', 'main'], work);
    await fxGit(['push', '-q', 'origin', '--delete', 'feat/a'], work);

    const branches = new Branches(0);
    try {
      const b = await branches.view(bare, 'feat/a', mine, true);
      expect(b.missing).toBeNull();
      expect(b.fetchError).toBeNull();
      expect(b.merged?.pr).toBe(5);
      expect(b.base).toBe(forkPoint);
      expect([b.ahead, b.behind]).toEqual([2, 0]);
      expect(b.files.map((f) => f.path)).toEqual(['README.md', 'new.txt']);
    } finally {
      await branches.close();
    }
  });

  it('shows the same change a month on, however far main has moved, and from a clone that never saw the branch', async () => {
    const before = new Branches(0);
    let then: Awaited<ReturnType<Branches['view']>>;
    try {
      then = await before.view(bare, 'feat/a', mine, true);
    } finally {
      await before.close();
    }
    await mkCommit(work, 'README.md', 'main rewrites the readme', 'main moves on again');
    await mkCommit(work, 'new.txt', 'main changes new.txt too', 'and again');
    await fxGit(['push', '-q', 'origin', 'main'], work);

    const fresh = await mkClone(bare, join(mkTempDir('yan-serve-fresh-'), 'clone'));
    for (const clone of [mine, fresh]) {
      const branches = new Branches(0);
      try {
        const b = await branches.view(bare, 'feat/a', clone, true);
        expect(b.missing).toBeNull();
        expect([b.base, b.head, b.merged?.pr]).toEqual([then.base, then.head, 5]);
        expect(b.files).toEqual(then.files);
        expect(b.commits.map((c) => c.sha)).toEqual(then.commits.map((c) => c.sha));
      } finally {
        await branches.close();
      }
    }
  });

  it('is not merged when it is only a commit main already had, just cut with nothing of its own', async () => {
    await fxGit(['push', '-q', 'origin', `${forkPoint}:refs/heads/feat/fresh`], work);
    const branches = new Branches(0);
    try {
      const b = await branches.view(bare, 'feat/fresh', mine, true);
      expect(b.missing).toBeNull();
      expect(b.merged).toBeNull();
      expect([b.ahead, b.files.length]).toEqual([0, 0]);
    } finally {
      await branches.close();
    }
  });

  it('says why when there is nothing to show', async () => {
    const branches = new Branches(0);
    try {
      expect((await branches.view(bare, 'feat/a', undefined)).missing).toMatch(/no clone/);
      expect((await branches.view(bare, 'never/was', mine)).missing).toMatch(/not on origin/);
      expect((await branches.view(bare, '-rf', mine)).missing).toMatch(/not a branch name/);
    } finally {
      await branches.close();
    }
  });
});
