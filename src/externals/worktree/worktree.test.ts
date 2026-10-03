import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanupTempDirs, fxGit, mkBareRemote, mkClone, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { normalizePath } from '../../util/paths.js';
import { cloneDir, poolRoot as resolvedRoot } from './layout.js';
import { WorktreePool, leasesHeldBy, returnTrees, treeState } from './index.js';

/**
 * The pool against real git and a real (local, bare) remote. No network.
 *
 * What is under test:
 *   - a tree is leased on a detached HEAD at its base, and the pool makes no
 *     branch
 *   - a returned tree is reset and cleaned, never with -x, so gitignored
 *     directories survive into the next lease, and left on no branch
 *   - a free tree still on a branch is taken off it before the next lease
 *   - the guard refuses to return a tree holding uncommitted or unpushed work,
 *     and --force is the one way past it
 *   - the pool grows when every slot is leased, and reuses a warm slot first
 *   - two concurrent gets never hand out the same tree
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let poolRoot = '';
let previousPool: string | undefined;

function pool(): WorktreePool {
  return new WorktreePool(clone);
}

beforeEach(async () => {
  previousPool = process.env.YAN_POOL_ROOT;
  home = mkYanHome(mkTempDir(), { withDist: true });
  poolRoot = mkTempDir('yan-pool-');
  process.env.YAN_POOL_ROOT = poolRoot;

  const bare = join(mkTempDir(), 'origin.git');
  await fxGit(['init', '--bare', '--initial-branch=main', bare], home);
  const seed = mkTempDir('yan-seed-');
  await fxGit(['init', '--initial-branch=main', '.'], seed);
  writeFileSync(join(seed, 'README.md'), 'fixture\n');
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n');
  await fxGit(['add', '.'], seed);
  await fxGit(['commit', '-m', 'initial'], seed);
  await fxGit(['remote', 'add', 'origin', bare], seed);
  await fxGit(['push', '-u', 'origin', 'main'], seed);

  clone = join(home, 'repos', 'demo');
  await fxGit(['clone', bare, clone], home);
  await fxGit(['config', 'user.name', 'yan tests'], clone);
  await fxGit(['config', 'user.email', 'yan-tests@localhost'], clone);
});

afterEach(() => {
  if (previousPool === undefined) delete process.env.YAN_POOL_ROOT;
  else process.env.YAN_POOL_ROOT = previousPool;
});

describe('the pool root', () => {
  it('is trees/ under the machine directory unless YAN_POOL_ROOT says otherwise', () => {
    delete process.env.YAN_POOL_ROOT;
    expect(resolvedRoot()).toBe(normalizePath(join(process.env.YAN_MACHINE_DIR as string, 'trees')));
    process.env.YAN_POOL_ROOT = poolRoot;
  });
});

describe('get', () => {
  it('leases a tree on a detached HEAD at its base, makes no branch, and the lease is found by holder', async () => {
    const grant = pool().get('origin/main', 't001');
    expect(grant.holder).toBe('t001');
    expect(existsSync(join(grant.path, 'README.md'))).toBe(true);
    expect((await fxGit(['rev-parse', '--abbrev-ref', 'HEAD'], grant.path)).stdout.trim()).toBe('HEAD');
    expect((await fxGit(['rev-parse', 'HEAD'], grant.path)).stdout.trim()).toBe((await fxGit(['rev-parse', 'origin/main'], clone)).stdout.trim());
    expect((await fxGit(['branch', '--format=%(refname:short)'], clone)).stdout.trim(), 'only the clone\'s own').toBe('main');

    const dir = cloneDir(clone);
    expect(grant.path).toBe(`${dir}/1/demo`);
    expect(leasesHeldBy('t001').map((l) => l.path)).toEqual([grant.path]);
    expect(leasesHeldBy('t002')).toEqual([]);
  });

  it('puts a warm slot back on a detached HEAD at the base, off the branch the last task cut', async () => {
    const first = pool().get('origin/main', 't001');
    await fxGit(['checkout', '-b', 'feature/t001'], first.path);
    returnTrees('t001');
    await fxGit(['commit', '--allow-empty', '-m', 'moved on'], clone);
    await fxGit(['push', 'origin', 'main'], clone);
    await fxGit(['fetch', 'origin'], clone);

    const next = pool().get('origin/main', 't002');
    expect(next.path).toBe(first.path);
    expect((await fxGit(['rev-parse', '--abbrev-ref', 'HEAD'], next.path)).stdout.trim()).toBe('HEAD');
    expect((await fxGit(['rev-parse', 'HEAD'], next.path)).stdout.trim()).toBe((await fxGit(['rev-parse', 'origin/main'], clone)).stdout.trim());
  });
});

describe('get on a branch', () => {
  const head = async (tree: string): Promise<string> => (await fxGit(['rev-parse', '--abbrev-ref', 'HEAD'], tree)).stdout.trim();
  const sha = async (ref: string, dir = clone): Promise<string> => (await fxGit(['rev-parse', ref], dir)).stdout.trim();

  it('puts a tree on a branch only origin has, tracking it', async () => {
    const first = pool().get('origin/main', 't001');
    await fxGit(['checkout', '-b', 'feat/a'], first.path);
    await fxGit(['commit', '--allow-empty', '-m', 'work'], first.path);
    await fxGit(['push', '-u', 'origin', 'feat/a'], first.path);
    returnTrees('t001');
    await fxGit(['branch', '-D', 'feat/a'], clone);

    const again = pool().get('origin/main', 't001', { branch: 'feat/a' });
    expect(await head(again.path)).toBe('feat/a');
    expect(await sha('HEAD', again.path)).toBe(await sha('origin/feat/a'));
    expect((await fxGit(['rev-parse', '--abbrev-ref', 'feat/a@{upstream}'], clone)).stdout.trim()).toBe('origin/feat/a');
  });

  it('puts a tree on the clone\'s own branch, brought up to origin\'s when it is only behind', async () => {
    const first = pool().get('origin/main', 't001');
    await fxGit(['checkout', '-b', 'feat/a'], first.path);
    await fxGit(['push', '-u', 'origin', 'feat/a'], first.path);
    await fxGit(['commit', '--allow-empty', '-m', 'from another machine'], first.path);
    await fxGit(['push', 'origin', 'feat/a'], first.path);
    await fxGit(['reset', '--hard', 'HEAD~1'], first.path);
    returnTrees('t001', { force: true });

    const again = pool().get('origin/main', 't001', { branch: 'feat/a' });
    expect(await head(again.path)).toBe('feat/a');
    expect(await sha('HEAD', again.path)).toBe(await sha('origin/feat/a'));
  });

  it('refuses a branch nobody has, or one held by another tree, and leases nothing', async () => {
    expect(() => pool().get('origin/main', 't001', { branch: 'feat/none' })).toThrow(/no branch feat\/none here or on origin/);
    await fxGit(['checkout', '-b', 'feat/held'], clone);
    let code = '';
    try {
      pool().get('origin/main', 't001', { branch: 'feat/held' });
    } catch (err) {
      code = (err as { code: string }).code;
    }
    expect(code).toBe('worktree_branch');
    expect(leasesHeldBy('t001')).toEqual([]);
    expect(await head(pool().get('origin/main', 't001').path), 'asked again without it').toBe('HEAD');
  });
});

describe('the pool grows instead of refusing', () => {
  it('cuts a new slot when every slot is leased, and reuses a warm one first', () => {
    const a = pool().get('origin/main', 'a');
    const b = pool().get('origin/main', 'b');
    const c = pool().get('origin/main', 'c');
    expect([a.path, b.path, c.path].map((p) => p.split('/').at(-2))).toEqual(['1', '2', '3']);

    mkdirSync(join(b.path, 'node_modules'), { recursive: true });
    writeFileSync(join(b.path, 'node_modules', 'warm.js'), '');
    returnTrees('b');
    const d = pool().get('origin/main', 'd');
    expect(d.path, 'the free warm slot, not a fourth').toBe(b.path);
    expect(existsSync(join(d.path, 'node_modules', 'warm.js'))).toBe(true);
  });
});

describe('returning a tree', () => {
  it('refuses a dirty tree, names what is in the way, and changes nothing', () => {
    const grant = pool().get('origin/main', 't001');
    writeFileSync(join(grant.path, 'stray.txt'), 'uncommitted\n');

    expect(treeState(grant.path).dirty).toEqual(['?? stray.txt']);
    expect(() => returnTrees('t001')).toThrow(/stray\.txt/);
    expect(() => returnTrees('t001')).toThrow(/--force/);
    expect(existsSync(join(grant.path, 'stray.txt'))).toBe(true);
    expect(leasesHeldBy('t001')).toHaveLength(1);
  });

  it('refuses a committed but unpushed HEAD', async () => {
    const grant = pool().get('origin/main', 't001');
    await fxGit(['checkout', '-b', 'feature/t001'], grant.path);
    writeFileSync(join(grant.path, 'feature.txt'), 'work\n');
    await fxGit(['add', '.'], grant.path);
    await fxGit(['commit', '-m', 'work'], grant.path);

    expect(treeState(grant.path).unpushed).toBe(true);
    expect(() => returnTrees('t001')).toThrow(/no remote branch contains HEAD/);

    await fxGit(['push', 'origin', 'feature/t001'], grant.path);
    expect(treeState(grant.path).unpushed, 'pushed, it exists on origin too').toBe(false);
  });

  it('with force, destroys the uncommitted work and keeps commits on the branch the agent cut', async () => {
    const grant = pool().get('origin/main', 't001');
    await fxGit(['checkout', '-b', 'feature/t001'], grant.path);
    writeFileSync(join(grant.path, 'feature.txt'), 'work\n');
    await fxGit(['add', '.'], grant.path);
    await fxGit(['commit', '-m', 'work'], grant.path);
    const head = (await fxGit(['rev-parse', 'HEAD'], grant.path)).stdout.trim();
    writeFileSync(join(grant.path, 'stray.txt'), 'uncommitted\n');

    expect(returnTrees('t001', { force: true })).toEqual([grant.path]);
    expect(existsSync(join(grant.path, 'stray.txt'))).toBe(false);
    expect((await fxGit(['rev-parse', 'feature/t001'], clone)).stdout.trim()).toBe(head);
    expect(leasesHeldBy('t001')).toEqual([]);
  });

  it('resets and cleans with -fd, never -x, so the tree stays warm', async () => {
    const grant = pool().get('origin/main', 't001');
    mkdirSync(join(grant.path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(grant.path, 'node_modules', 'dep', 'index.js'), '// warm\n');
    await fxGit(['checkout', '-b', 'feature/t001'], grant.path);
    writeFileSync(join(grant.path, 'feature.txt'), 'work\n');
    await fxGit(['add', '.'], grant.path);
    await fxGit(['commit', '-m', 'work'], grant.path);
    expect((await fxGit(['push', 'origin', 'feature/t001'], grant.path)).code).toBe(0);

    expect(returnTrees('t001')).toEqual([grant.path]);
    expect(existsSync(join(grant.path, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(cloneDir(clone), 'leases', '1.json'))).toBe(false);

    const next = pool().get('origin/main', 't002');
    expect(next.path).toBe(grant.path);
    expect(existsSync(join(next.path, 'feature.txt')), 'cut from the base, not from the last task').toBe(false);
  });

  it('with trees of two repositories, touches neither while one holds work, then returns both', async () => {
    const other = await mkClone(await mkBareRemote(join(mkTempDir(), 'web.git')), join(mkTempDir(), 'web'));
    const a = pool().get('origin/main', 't001');
    const b = new WorktreePool(other).get('origin/main', 't001');
    writeFileSync(join(b.path, 'stray.txt'), 'uncommitted\n');

    expect(() => returnTrees('t001')).toThrow(/stray\.txt/);
    expect(leasesHeldBy('t001'), 'the clean one was not returned first').toHaveLength(2);
    expect(existsSync(a.path)).toBe(true);

    expect(returnTrees('t001', { force: true }).sort()).toEqual([a.path, b.path].sort());
    expect(leasesHeldBy('t001')).toEqual([]);
  });

  it('leaves the tree on no branch, so the branch the agent cut can be checked out elsewhere', async () => {
    const grant = pool().get('origin/main', 't001');
    await fxGit(['checkout', '-b', 'feature/t001'], grant.path);
    const head = (await fxGit(['rev-parse', 'HEAD'], grant.path)).stdout.trim();
    returnTrees('t001');

    expect((await fxGit(['rev-parse', '--abbrev-ref', 'HEAD'], grant.path)).stdout.trim()).toBe('HEAD');
    expect((await fxGit(['rev-parse', 'HEAD'], grant.path)).stdout.trim(), 'on the commit it was on').toBe(head);
    expect((await fxGit(['checkout', 'feature/t001'], clone)).code).toBe(0);
  });

  it('takes a free tree returned on a branch off it before the next lease', async () => {
    pool().get('origin/main', 't001');
    const held = pool().get('origin/main', 't002');
    await fxGit(['checkout', '-b', 'feature/t002'], held.path);
    // Returned by a yan from before returning detached: the lease gone, the branch kept.
    rmSync(join(cloneDir(clone), 'leases', '1.json'));
    rmSync(join(cloneDir(clone), 'leases', '2.json'));
    pool().get('origin/main', 't003');

    expect((await fxGit(['rev-parse', '--abbrev-ref', 'HEAD'], held.path)).stdout.trim()).toBe('HEAD');
    expect((await fxGit(['checkout', 'feature/t002'], clone)).code).toBe(0);
  });

  it('is nothing to do for a holder with no tree', () => {
    expect(returnTrees('nobody')).toEqual([]);
  });
});

describe('two concurrent gets never hand out the same tree', () => {
  it('and never collide inside git either', async () => {
    const entry = pathToFileURL(join(home, 'dist', 'externals', 'worktree', 'index.js')).href;
    const race = (holder: string): Promise<{ code: number; out: string }> =>
      new Promise((done) => {
        const script = `import { WorktreePool } from ${JSON.stringify(entry)};
process.stdout.write(JSON.stringify(new WorktreePool(${JSON.stringify(clone)}).get('origin/main', ${JSON.stringify(holder)})));`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
          env: { ...process.env, YAN_POOL_ROOT: poolRoot },
          windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (code) => done({ code: code ?? 1, out }));
      });

    const [one, two] = await Promise.all([race('one'), race('two')]);
    expect(one.code, one.out).toBe(0);
    expect(two.code, two.out).toBe(0);
    expect((JSON.parse(one.out) as { path: string }).path).not.toBe((JSON.parse(two.out) as { path: string }).path);
    expect(readdirSync(join(cloneDir(clone), 'leases')).sort()).toEqual(['1.json', '2.json']);
    expect(existsSync(join(cloneDir(clone), 'lock'))).toBe(false);
  });
});
