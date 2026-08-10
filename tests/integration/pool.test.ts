import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../helpers/fixtures.js';
import { normalizePath } from '../../src/util/paths.js';

/**
 * The pool against real git and a real (local, bare) remote. No network.
 *
 * Phase 3 Trace:
 *   - return uses `reset --hard` + `clean -fd` and NEVER -x; gitignored
 *     directories survive a round trip
 *   - the orphan-commit guard refuses to return a tree holding uncommitted or
 *     unpushed work
 *   - a full pool is backpressure, not silent growth
 *   - a conditional return refuses a mismatched --if-lease-id /
 *     --if-lease-holder BEFORE any destructive step
 *   - path comparison against git's native output still normalises
 *
 * …plus the requirement the MVP's directory lock existed for: two concurrent
 * `get`s must never hand out the same tree. There is no lock in the ported
 * seam — the lease file is the claim — so that test is the one that says the
 * substitution actually holds.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let poolRoot = '';
let previousHome: string | undefined;
let previousPool: string | undefined;

function fxGit(args: readonly string[], cwd: string) {
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.name=yan tests',
      '-c',
      'user.email=yan-tests@localhost',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

async function pool() {
  return import('../../src/seams/pool/index.js');
}

beforeEach(() => {
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
  fxGit(['init', '--bare', '--initial-branch=main', bare], home);
  const seed = mkTempDir('yan-seed-');
  fxGit(['init', '--initial-branch=main', '.'], seed);
  writeFileSync(join(seed, 'README.md'), 'fixture\n');
  writeFileSync(join(seed, '.gitignore'), 'node_modules/\n');
  fxGit(['add', '.'], seed);
  fxGit(['commit', '-m', 'initial'], seed);
  fxGit(['remote', 'add', 'origin', bare], seed);
  fxGit(['push', '-u', 'origin', 'main'], seed);
  fxGit(['checkout', '-b', 'integ'], seed);
  fxGit(['push', '-u', 'origin', 'integ'], seed);

  clone = join(home, 'repos', 'demo');
  fxGit(['clone', bare, clone], home);
  fxGit(['config', 'user.name', 'yan tests'], clone);
  fxGit(['config', 'user.email', 'yan-tests@localhost'], clone);
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
  if (previousPool === undefined) delete process.env.YAN_POOL_ROOT;
  else process.env.YAN_POOL_ROOT = previousPool;
});

describe('get', () => {
  it('leases a tree, cuts the shift branch, and reports the grant', async () => {
    const p = await pool();
    const grant = p.poolGet(clone, 2, 'integ', 'shift/t042-s1', 't042/auth/s1');

    expect(Object.keys(grant).sort()).toEqual(['holder', 'lease_id', 'path']);
    expect(grant.holder).toBe('t042/auth/s1');
    expect(grant.lease_id).not.toBe('');
    expect(existsSync(join(grant.path, 'README.md'))).toBe(true);

    // The tree is on a real branch, never detached: shift branches have to be
    // pushed and turned into MRs.
    expect(fxGit(['rev-parse', '--abbrev-ref', 'HEAD'], grant.path).stdout.trim()).toBe(
      'shift/t042-s1',
    );

    // The layout is <pool root>/<repo>-<hash>/<slot>/<repo>, and the leases
    // live in the pool's own root, never under $YAN_HOME (td INDEX.md §3).
    const dir = p.poolDir(clone);
    expect(grant.path).toContain('/1/demo');
    expect(grant.path.startsWith(`${dir}/`)).toBe(true);
    expect(existsSync(join(dir, 'leases', '1.json'))).toBe(true);
    expect(grant.path.toLowerCase()).not.toContain(normalizePath(home).toLowerCase());

    // git knows the tree by its OWN spelling of the path; the comparison has to
    // normalise before it can compare (conventions §3).
    const listed = fxGit(['worktree', 'list', '--porcelain'], clone).stdout;
    const registered = listed
      .split(/\r?\n/)
      .filter((l) => l.startsWith('worktree '))
      .map((l) => normalizePath(l.slice('worktree '.length)));
    expect(registered).toContain(normalizePath(grant.path));
  });

  it('status is a registry of who holds what', async () => {
    const p = await pool();
    const grant = p.poolGet(clone, 2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    const status = p.poolStatus(clone);
    expect(status).toHaveLength(1);
    expect(status[0]?.holder).toBe('t042/auth/s1');
    expect(status[0]?.lease_id).toBe(grant.lease_id);
    expect(status[0]?.branch).toBe('shift/t042-s1');
  });
});

describe('the orphan-commit guard', () => {
  it('refuses a tree with uncommitted changes, and changes nothing', async () => {
    const p = await pool();
    const grant = p.poolGet(clone, 2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    mkdirSync(join(grant.path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(grant.path, 'node_modules', 'dep', 'index.js'), '// warm\n');
    writeFileSync(join(grant.path, 'stray.txt'), 'uncommitted\n');

    expect(() => p.poolReturn(clone, grant.path)).toThrow(/uncommitted changes/);
    expect(existsSync(join(grant.path, 'stray.txt'))).toBe(true);
    expect(existsSync(join(grant.path, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(p.poolDir(clone), 'leases', '1.json'))).toBe(true);
  });

  it('refuses a committed but unpushed HEAD', async () => {
    const p = await pool();
    const grant = p.poolGet(clone, 2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    writeFileSync(join(grant.path, 'feature.txt'), 'work\n');
    fxGit(['add', '.'], grant.path);
    fxGit(['commit', '-m', 'work'], grant.path);

    expect(() => p.poolReturn(clone, grant.path)).toThrow(/no remote branch contains HEAD/);
    expect(existsSync(join(grant.path, 'feature.txt'))).toBe(true);
  });
});

describe('the conditional return', () => {
  it('refuses a mismatched identity before any destructive step', async () => {
    const p = await pool();
    const grant = p.poolGet(clone, 2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    // Deliberately dirty: a dirty tree would fail the orphan guard, so a
    // mismatch code proves the identity check ran FIRST — before the guard,
    // before reset, before clean.
    writeFileSync(join(grant.path, 'stray2.txt'), 'x\n');

    let thrown: unknown;
    try {
      p.poolReturn(clone, grant.path, 'not-the-lease-id');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code: string }).code).toBe(p.POOL_MISMATCH);
    expect((thrown as { exitCode: number }).exitCode).toBe(3);
    expect((thrown as Error).message).toContain('nothing was touched');
    expect(existsSync(join(grant.path, 'stray2.txt'))).toBe(true);

    thrown = undefined;
    try {
      p.poolReturn(clone, grant.path, '', 'someone/else/s9');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code: string }).code).toBe(p.POOL_MISMATCH);
    expect((thrown as Error).message).toContain('holder does not match');

    // With a matching identity the guard is what refuses.
    expect(() => p.poolReturn(clone, grant.path, grant.lease_id, grant.holder)).toThrow(
      /uncommitted changes/,
    );
  });
});

describe('return keeps the tree warm', () => {
  it('reset --hard + clean -fd, never -x', async () => {
    const p = await pool();
    const grant = p.poolGet(clone, 2, 'integ', 'shift/t042-s1', 't042/auth/s1');
    mkdirSync(join(grant.path, 'node_modules', 'dep'), { recursive: true });
    writeFileSync(join(grant.path, 'node_modules', 'dep', 'index.js'), '// warm\n');
    writeFileSync(join(grant.path, 'feature.txt'), 'work\n');
    fxGit(['add', '.'], grant.path);
    fxGit(['commit', '-m', 'work'], grant.path);
    expect(fxGit(['push', 'origin', 'shift/t042-s1'], grant.path).code).toBe(0);

    expect(p.poolReturn(clone, grant.path, grant.lease_id, grant.holder)).toBe(grant.path);
    // The whole point of the pool.
    expect(existsSync(join(grant.path, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(existsSync(join(grant.path, 'feature.txt'))).toBe(true);
    expect(existsSync(join(p.poolDir(clone), 'leases', '1.json'))).toBe(false);
    expect(p.poolStatus(clone)).toEqual([]);

    // …and the next shift leases the same slot, still warm.
    const second = p.poolGet(clone, 2, 'integ', 'shift/t042-s2', 't042/auth/s2');
    expect(second.path).toBe(grant.path);
    expect(existsSync(join(second.path, 'node_modules', 'dep', 'index.js'))).toBe(true);
    expect(second.lease_id).not.toBe(grant.lease_id);
    // The new branch is cut from the base, not from the last shift.
    expect(existsSync(join(second.path, 'feature.txt'))).toBe(false);

    // The slot number, not just the path, identifies a lease.
    expect(p.poolReturn(clone, '1')).toBe(second.path);
    expect(p.poolStatus(clone)).toEqual([]);
  });

  it('returning something nobody leased is an error, not a silent no-op', async () => {
    const p = await pool();
    expect(() => p.poolReturn(clone, join(poolRoot, 'nothing'))).toThrow(/no lease matches/);
  });
});

describe('a full pool is backpressure, not silent growth', () => {
  it('refuses without creating a third tree', async () => {
    const p = await pool();
    const a = p.poolGet(clone, 2, 'integ', 'shift/a', 't/u/a');
    const b = p.poolGet(clone, 2, 'integ', 'shift/b', 't/u/b');
    expect(a.path).not.toBe(b.path);

    let thrown: unknown;
    try {
      p.poolGet(clone, 2, 'integ', 'shift/c', 't/u/c');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toContain('pool is full');
    // The message must not read like a sync failure.
    expect((thrown as Error).message).toContain('cannot start a new shift');
    expect(existsSync(join(p.poolDir(clone), '3'))).toBe(false);
    expect(p.poolStatus(clone)).toHaveLength(2);

    // The size is a per-repository setting, so the same pool with a larger size
    // hands out a third tree - the refusal above was backpressure, not
    // breakage.
    const c = p.poolGet(clone, 3, 'integ', 'shift/c', 't/u/c');
    expect(p.poolStatus(clone)).toHaveLength(3);
    p.poolReturn(clone, c.path);
    p.poolReturn(clone, a.path);
    p.poolReturn(clone, b.path);
    expect(p.poolStatus(clone)).toEqual([]);
  });
});

describe('two concurrent gets never hand out the same tree', () => {
  it('and never collide inside git either', async () => {
    const p = await pool();
    // Two separate processes, started together, through the real dispatcher.
    const race = (branch: string, holder: string): Promise<{ code: number; out: string }> =>
      new Promise((done) => {
        const child = spawn(
          'bash',
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

    const status = p.poolStatus(clone);
    expect(status).toHaveLength(2);
    expect(new Set(status.map((s) => s.path)).size).toBe(2);
    expect(readdirSync(join(p.poolDir(clone), 'leases')).sort()).toEqual(['1.json', '2.json']);

    // The lock is always released.
    expect(existsSync(join(p.poolDir(clone), 'lock'))).toBe(false);
  });
});

describe('yan tree, the command layer', () => {
  function yan(args: readonly string[]) {
    const r = spawnSync('bash', [join(home, 'bin', 'yan'), 'tree', ...args], {
      encoding: 'utf8',
      env: { ...process.env, YAN_HOME: home, YAN_POOL_ROOT: poolRoot },
      windowsHide: true,
    });
    return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  }

  it('reads pool_size from mem/repos.json, which the seam must not read', () => {
    writeFileSync(
      join(home, 'mem', 'repos.json'),
      `${JSON.stringify({ version: 1, demo: { url: 'x', mode_default: 'mr', pool_size: 1 } }, null, 2)}\n`,
    );
    expect(yan(['get', '--repo', 'demo', '--base', 'integ', '--branch', 's1', '--holder', 't/u/1']).code).toBe(0);
    const full = yan(['get', '--repo', 'demo', '--base', 'integ', '--branch', 's2', '--holder', 't/u/2']);
    expect(full.code).not.toBe(0);
    expect(full.stderr).toContain('pool is full');
    expect(yan(['status', '--repo', 'demo']).stdout).toContain('1 of 1 trees leased');
  });

  it('exits 3 on a refused conditional return, and 2 when called wrongly', () => {
    const got = yan(['get', '--repo', 'demo', '--base', 'integ', '--branch', 's1', '--holder', 't/u/1', '--json']);
    expect(got.code, got.stderr).toBe(0);
    const grant = JSON.parse(got.stdout) as { path: string };

    const refused = yan(['return', '--repo', 'demo', '--path', grant.path, '--if-lease-id', 'nope']);
    expect(refused.code).toBe(3);

    expect(yan(['get', '--repo', 'demo', '--base', 'integ']).code).toBe(2);
    expect(yan(['return', '--repo', 'demo']).code).toBe(2);
    expect(yan(['status', '--repo', 'nosuchrepo']).code).toBe(2);
  });
});
