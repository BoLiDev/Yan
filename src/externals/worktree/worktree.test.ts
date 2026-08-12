import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bashCommand,
  cleanupTempDirs,
  fxGit,
  mkTempDir,
  mkYanHome,
  registerRepo,
  runYan,
} from '../../../tests/helpers/fixtures.js';
import { normalizePath } from '../../util/paths.js';
import { WorktreeError } from './errors.js';
import { cloneDir } from './layout.js';
import { WorktreePool } from './index.js';

/**
 * The pool against real git and a real (local, bare) remote. No network.
 *
 * This test lives beside the module on purpose: it reaches for `cloneDir` and
 * `WorktreeError`, which are the module's own business and are not exported
 * from `index.ts`. A test in `tests/` could only see them by widening the
 * public surface, which is how the surface got wide in the first place.
 *
 * What is under test:
 *   - return uses `reset --hard` + `clean -fd` and never -x; gitignored
 *     directories survive a round trip
 *   - the orphan-commit guard refuses to return a tree holding uncommitted or
 *     unpushed work
 *   - a full pool is backpressure, not silent growth
 *   - a conditional return refuses a mismatched identity before any destructive
 *     step
 *   - path comparison against git's native output still normalises
 *
 * …plus the requirement the lock exists for: two concurrent `get`s must never
 * hand out the same tree, and must not collide inside git's own config lock.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let poolRoot = '';
let previousHome: string | undefined;
let previousPool: string | undefined;

/** The pool under test. `clone` is only known once beforeEach has run. */
function pool(): WorktreePool {
  return new WorktreePool(clone);
}


beforeEach(async () => {
  previousHome = process.env.YAN_HOME;
  previousPool = process.env.YAN_POOL_ROOT;
  home = mkYanHome(mkTempDir(), { withDist: true });
  // The pool never touches the real ~/.yan-trees during a test run.
  poolRoot = mkTempDir('yan-pool-');
  process.env.YAN_HOME = home;
  process.env.YAN_POOL_ROOT = poolRoot;

  // A repository whose integration branch exists only on the remote, which is
  // the ordinary case for a freshly cloned repo.
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
  await fxGit(['checkout', '-b', 'integ'], seed);
  await fxGit(['push', '-u', 'origin', 'integ'], seed);

  clone = join(home, 'repos', 'demo');
  await fxGit(['clone', bare, clone], home);
  await fxGit(['config', 'user.name', 'yan tests'], clone);
  await fxGit(['config', 'user.email', 'yan-tests@localhost'], clone);
  // A clone is where the registry says it is now, not where a convention put
  // it. The path does not change; only the reason yan
  // can find it.
  registerRepo(home, 'demo', clone, { url: bare, pool_size: 2 });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
  if (previousPool === undefined) delete process.env.YAN_POOL_ROOT;
  else process.env.YAN_POOL_ROOT = previousPool;
});

describe('the constructor', () => {
  it('refuses a clone that is not a directory, once, instead of on every call', () => {
    expect(() => new WorktreePool('')).toThrow(/main clone directory is required/);
    expect(() => new WorktreePool(join(poolRoot, 'nope'))).toThrow(/not a directory/);
  });
});

describe('a branch the main clone is sitting on', () => {
  /**
   * The one refusal that only became reachable in V3.
   *
   * Under `$YAN_HOME/repos/` the main clone was yan's own and nobody ever
   * checked anything out in it, so "a branch cannot be checked out twice" could
   * not happen. The registered clone is now the one `user` works in, and it
   * happens on an ordinary Tuesday — so the message has to name the branch, the
   * directory holding it, and the fix, rather than passing git's wording on.
   */
  it('names the branch, the directory and the fix, and moves nobody', async () => {
    // `user` is working on the branch a shift is about to be dispatched onto.
    await fxGit(['checkout', '-b', 'shift/occupied', 'origin/integ'], clone);

    expect(() => pool().get(2, 'integ', 'shift/occupied', 't042/auth/s1')).toThrow(
      /already checked out in .*never moves a clone it does not own/s,
    );
    // The user's own clone is exactly where they left it.
    expect((await fxGit(['rev-parse', '--abbrev-ref', 'HEAD'], clone)).stdout.trim()).toBe('shift/occupied');
    await fxGit(['checkout', 'main'], clone);
  });
});

describe('get', () => {
  it('leases a tree, cuts the shift branch, and reports the grant', async () => {
    const grant = pool().get(2, 'integ', 'shift/t042-s1', 't042/auth/s1');

    expect(Object.keys(grant).sort()).toEqual(['holder', 'lease_id', 'path']);
    expect(grant.holder).toBe('t042/auth/s1');
    expect(grant.lease_id).not.toBe('');
    expect(existsSync(join(grant.path, 'README.md'))).toBe(true);

    // The tree is on a real branch, never detached: shift branches have to be
    // pushed and turned into MRs.
    expect((await fxGit(['rev-parse', '--abbrev-ref', 'HEAD'], grant.path)).stdout.trim()).toBe(
      'shift/t042-s1',
    );

    // The layout is <pool root>/<repo>-<hash>/<slot>/<repo>, and the leases
    // live in the pool's own root, never under $YAN_HOME.
    const dir = cloneDir(clone);
    expect(grant.path).toContain('/1/demo');
    expect(grant.path.startsWith(`${dir}/`)).toBe(true);
    expect(existsSync(join(dir, 'leases', '1.json'))).toBe(true);
    expect(grant.path.toLowerCase()).not.toContain(normalizePath(home).toLowerCase());

    // git knows the tree by its own spelling of the path; the comparison has to
    // normalise before it can compare.
    const listed = (await fxGit(['worktree', 'list', '--porcelain'], clone)).stdout;
    const registered = listed
      .split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => normalizePath(l.slice('worktree '.length)));
    expect(registered).toContain(normalizePath(grant.path));
  });

  it('status is a registry of who holds what', () => {
    const grant = pool().get(2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    const status = pool().status();
    expect(status).toHaveLength(1);
    expect(status[0]?.holder).toBe('t042/auth/s1');
    expect(status[0]?.lease_id).toBe(grant.lease_id);
    expect(status[0]?.branch).toBe('shift/t042-s1');
  });
});

describe('the orphan-commit guard', () => {
  it('refuses a dirty tree, names what is in the way, and changes nothing', () => {
    const grant = pool().get(2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    mkdirSync(join(grant.path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(grant.path, 'node_modules', 'dep', 'index.js'), '// warm\n');
    writeFileSync(join(grant.path, 'stray.txt'), 'uncommitted\n');

    // The paths are the point: a refusal that only says "it is dirty" sends
    // the reader back to the tree to run git status themselves.
    expect(() => pool().return(grant.path)).toThrow(/dirty/);
    expect(() => pool().return(grant.path)).toThrow(/stray\.txt/);
    expect(() => pool().return(grant.path)).toThrow(/--discard --user-asked/);
    expect(existsSync(join(grant.path, 'stray.txt'))).toBe(true);
    expect(existsSync(join(grant.path, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(cloneDir(clone), 'leases', '1.json'))).toBe(true);
  });

  it('refuses a committed but unpushed HEAD', async () => {
    const grant = pool().get(2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    writeFileSync(join(grant.path, 'feature.txt'), 'work\n');
    await fxGit(['add', '.'], grant.path);
    await fxGit(['commit', '-m', 'work'], grant.path);

    expect(() => pool().return(grant.path)).toThrow(/no remote branch contains HEAD/);
    expect(existsSync(join(grant.path, 'feature.txt'))).toBe(true);
  });
});

/**
 * A force flag is not forbidden, it is authorised: forbidden,
 * unless `user` says the changes can be thrown away.* `yan done --force` is the
 * only caller, and this is what it buys — recovering a slot the guard has, quite
 * correctly, refused to release.
 */
describe('force is the one door past the guard', () => {
  it('releases a dirty tree, and destroys exactly the uncommitted work', () => {
    const grant = pool().get(2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    mkdirSync(join(grant.path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(grant.path, 'node_modules', 'dep', 'index.js'), '// warm\n');
    writeFileSync(join(grant.path, 'stray.txt'), 'uncommitted\n');

    expect(pool().return(grant.path, { force: true })).toBe(grant.path);
    expect(existsSync(join(grant.path, 'stray.txt')), 'the untracked file is gone').toBe(false);
    expect(
      existsSync(join(grant.path, 'node_modules', 'dep', 'index.js')),
      'and -x is still never passed, so the tree comes back warm',
    ).toBe(true);
    expect(existsSync(join(cloneDir(clone), 'leases', '1.json')), 'the slot is free').toBe(false);
  });

  it('does NOT destroy commits: they stay on the shift branch, reachable by name', async () => {
    const grant = pool().get(2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    writeFileSync(join(grant.path, 'feature.txt'), 'work\n');
    await fxGit(['add', '.'], grant.path);
    await fxGit(['commit', '-m', 'work'], grant.path);
    const head = (await fxGit(['rev-parse', 'HEAD'], grant.path)).stdout.trim();

    expect(pool().return(grant.path, { force: true })).toBe(grant.path);

    // The distinction the help text makes, proved rather than asserted: the
    // unpushed commit survives in the clone under its branch name. What force
    // throws away is the working tree, not history.
    const still = await fxGit(['rev-parse', 'shift/t042-s1'], clone);
    expect(still.code, still.stderr).toBe(0);
    expect(still.stdout.trim()).toBe(head);
  });

  it('still refuses a mismatched identity - force is not a licence for the wrong slot', () => {
    const grant = pool().get(2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    writeFileSync(join(grant.path, 'stray.txt'), 'uncommitted\n');

    expect(() => pool().return(grant.path, { force: true, holder: 'someone/else/s9' })).toThrow(
      /holder does not match/,
    );
    expect(existsSync(join(grant.path, 'stray.txt')), 'nothing was touched').toBe(true);
  });
});

describe('the conditional return', () => {
  it('refuses a mismatched identity before any destructive step', () => {
    const grant = pool().get(2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    // Deliberately dirty: a dirty tree would fail the orphan guard, so a
    // mismatch code proves the identity check ran first — before the guard,
    // before reset, before clean.
    writeFileSync(join(grant.path, 'stray2.txt'), 'x\n');

    let thrown: unknown;
    try {
      pool().return(grant.path, { leaseId: 'not-the-lease-id' });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code: string }).code).toBe(WorktreeError.codes.mismatch);
    expect((thrown as { exitCode: number }).exitCode).toBe(3);
    expect((thrown as Error).message).toContain('nothing was touched');
    expect(existsSync(join(grant.path, 'stray2.txt'))).toBe(true);

    thrown = undefined;
    try {
      pool().return(grant.path, { holder: 'someone/else/s9' });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code: string }).code).toBe(WorktreeError.codes.mismatch);
    expect((thrown as Error).message).toContain('holder does not match');

    // With a matching identity the guard is what refuses.
    expect(() =>
      pool().return(grant.path, { leaseId: grant.lease_id, holder: grant.holder }),
    ).toThrow(/dirty/);
  });
});

describe('return keeps the tree warm', () => {
  it('reset --hard + clean -fd, never -x', async () => {
    const grant = pool().get(2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    mkdirSync(join(grant.path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(grant.path, 'node_modules', 'dep', 'index.js'), '// warm\n');
    writeFileSync(join(grant.path, 'feature.txt'), 'work\n');
    await fxGit(['add', '.'], grant.path);
    await fxGit(['commit', '-m', 'work'], grant.path);
    expect((await fxGit(['push', 'origin', 'shift/t042-s1'], grant.path)).code).toBe(0);

    expect(pool().return(grant.path, { leaseId: grant.lease_id, holder: grant.holder })).toBe(
      grant.path,
    );
    // The whole point of the pool.
    expect(existsSync(join(grant.path, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(grant.path, 'feature.txt'))).toBe(true);
    expect(existsSync(join(cloneDir(clone), 'leases', '1.json'))).toBe(false);
    expect(pool().status()).toEqual([]);

    // …and the next shift leases the same slot, still warm.
    const second = pool().get(2, 'integ', 'shift/t042-s2', 't042/auth/s2');
    expect(second.path).toBe(grant.path);
    expect(existsSync(join(second.path, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(second.lease_id).not.toBe(grant.lease_id);
    // The new branch is cut from the base, not from the last shift.
    expect(existsSync(join(second.path, 'feature.txt'))).toBe(false);

    // The slot number, not just the path, identifies a lease.
    expect(pool().return('1')).toBe(second.path);
    expect(pool().status()).toEqual([]);
  });

  it('returning something nobody leased is an error, not a silent no-op', () => {
    expect(() => pool().return(join(poolRoot, 'nothing'))).toThrow(/no lease matches/);
  });
});

describe('a full pool is backpressure, not silent growth', () => {
  it('refuses without creating a third tree', () => {
    const a = pool().get(2, 'integ', 'shift/a', 't/u/a');
    const b = pool().get(2, 'integ', 'shift/b', 't/u/b');
    expect(a.path).not.toBe(b.path);

    let thrown: unknown;
    try {
      pool().get(2, 'integ', 'shift/c', 't/u/c');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toContain('pool is full');
    // The message must not read like a sync failure.
    expect((thrown as Error).message).toContain('cannot start a new shift');
    expect(existsSync(join(cloneDir(clone), '3'))).toBe(false);
    expect(pool().status()).toHaveLength(2);

    // The size is a per-repository setting, so the same pool with a larger size
    // hands out a third tree - the refusal above was backpressure, not
    // breakage.
    const c = pool().get(3, 'integ', 'shift/c', 't/u/c');
    expect(pool().status()).toHaveLength(3);
    pool().return(c.path);
    pool().return(a.path);
    pool().return(b.path);
    expect(pool().status()).toEqual([]);
  });
});

describe('two concurrent gets never hand out the same tree', () => {
  it('and never collide inside git either', async () => {
    // Two separate processes, started together, through the real dispatcher.
    const race = (branch: string, holder: string): Promise<{ code: number; out: string }> =>
      new Promise((done) => {
        const child = spawn(
          bashCommand(),
          [
            join(home, 'bin', 'yan'),
            'tree',
            'get',
            '--repo',
            'demo',
            '--base',
            'integ',
            '--branch',
            branch,
            '--holder',
            holder,
            '--json',
          ],
          { env: { ...process.env, YAN_HOME: home, YAN_POOL_ROOT: poolRoot }, windowsHide: true },
        );
        let out = '';
        child.stdout.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', (code) => done({ code: code ?? 1, out }));
      });

    const [one, two] = await Promise.all([race('shift/one', 't/u/one'), race('shift/two', 't/u/two')]);
    expect(one.code, one.out).toBe(0);
    expect(two.code, two.out).toBe(0);

    const first = JSON.parse(one.out) as { path: string; lease_id: string };
    const second = JSON.parse(two.out) as { path: string; lease_id: string };
    expect(first.path).not.toBe(second.path);
    expect(first.lease_id).not.toBe(second.lease_id);

    const status = pool().status();
    expect(status).toHaveLength(2);
    expect(new Set(status.map((s) => s.path)).size).toBe(2);
    expect(readdirSync(join(cloneDir(clone), 'leases')).sort()).toEqual(['1.json', '2.json']);

    // The lock is always released.
    expect(existsSync(join(cloneDir(clone), 'lock'))).toBe(false);
  });
});

describe('yan tree, the command layer', () => {
  // The shared helper, bound to this file's home and pool. It was a local copy
  // on spawnSync until the suite went parallel again.
  function yan(args: readonly string[]) {
    return runYan(home, ['tree', ...args], { YAN_POOL_ROOT: poolRoot });
  }

  it('reads pool_size from the vault registry, which this module must not read', async () => {
    // Tuning lives on the portable half: it follows the repository between
    // machines, unlike the path beside it.
    registerRepo(home, 'demo', clone, { url: 'x', pool_size: 1 });
    expect((await yan(['get', '--repo', 'demo', '--base', 'integ', '--branch', 's1', '--holder', 't/u/1'])).code).toBe(0);
    const full = await yan(['get', '--repo', 'demo', '--base', 'integ', '--branch', 's2', '--holder', 't/u/2']);
    expect(full.code).not.toBe(0);
    expect(full.stderr).toContain('pool is full');
    expect((await yan(['status', '--repo', 'demo'])).stdout).toContain('1 of 1 trees leased');
  });

  it('exits 3 on a refused conditional return, and 2 when called wrongly', async () => {
    const got = await yan(['get', '--repo', 'demo', '--base', 'integ', '--branch', 's1', '--holder', 't/u/1', '--json']);
    expect(got.code, got.stderr).toBe(0);
    const grant = JSON.parse(got.stdout) as { path: string };

    const refused = await yan(['return', '--repo', 'demo', '--path', grant.path, '--if-lease-id', 'nope']);
    expect(refused.code).toBe(3);

    expect((await yan(['get', '--repo', 'demo', '--base', 'integ'])).code).toBe(2);
    expect((await yan(['return', '--repo', 'demo'])).code).toBe(2);
    expect((await yan(['status', '--repo', 'nosuchrepo'])).code).toBe(2);
  });

  it('will not discard work without being told `user` said so, and says the slot is still held', async () => {
    const got = await yan(['get', '--repo', 'demo', '--base', 'integ', '--branch', 's1', '--holder', 't/u/1', '--json']);
    expect(got.code, got.stderr).toBe(0);
    const grant = JSON.parse(got.stdout) as { path: string };
    writeFileSync(join(grant.path, 'stray.txt'), 'uncommitted\n');

    // --discard on its own is the shape a retry would have, and a retry must
    // never be able to destroy this.
    const alone = await yan(['return', '--repo', 'demo', '--path', grant.path, '--discard']);
    expect(alone.code).toBe(2);
    expect(alone.stderr).toContain('--user-asked');
    expect(existsSync(join(grant.path, 'stray.txt')), 'and nothing was touched').toBe(true);

    // So is --user-asked with nothing to answer.
    expect((await yan(['return', '--repo', 'demo', '--path', grant.path, '--user-asked'])).code).toBe(2);

    // The plain refusal names both ways out rather than dead-ending.
    const refused = await yan(['return', '--repo', 'demo', '--path', grant.path]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain('stray.txt');
    expect(refused.stderr).toContain('--discard --user-asked');

    // Together they release the slot, which is the whole point of the door.
    const discarded = await yan(['return', '--repo', 'demo', '--path', grant.path, '--discard', '--user-asked']);
    expect(discarded.code, discarded.stderr).toBe(0);
    expect(existsSync(join(grant.path, 'stray.txt'))).toBe(false);
    expect((await yan(['status', '--repo', 'demo'])).stdout).not.toContain('t/u/1');
  });
});
