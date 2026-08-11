import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkClone,
  mkCommit,
  mkTempDir,
  mkYanHome,
  runYan,
} from '../helpers/fixtures.js';
import { repoRoot } from '../helpers/fixtures.js';

/**
 * `yan sync`, ported from `tests/integration/yan-sync.test.sh` and
 * `tests/unit/yan-unit-args.test.sh`.
 *
 * Phase 7 Trace: "`sync` exits immediately on conflict and never resolves one"
 * — one of the four MVP ordering regressions, none of which fails loudly. So
 * the conflict below is a genuine one: two commits changing the same line of
 * the same file.
 *
 * And the pool-full trap (worktree.md §7 names it): when the pool is full the
 * error says "the pool is full, cannot start a new shift", NOT "sync failed".
 * sync is the first step of `yan shift new`, so a vague message sends the
 * reader hunting for a synchronisation problem that does not exist.
 *
 * Real git, local bare remote, real pool. No network, no host, no agent.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let bare = '';
let work = '';
let poolRoot = '';

async function yan(args: readonly string[]) {
  return await runYan(home, args, { YAN_POOL_ROOT: poolRoot });
}

async function leases(): Promise<number> {
  const r = await yan(['tree', 'status', '--repo', 'demo', '--json']);
  return (JSON.parse(r.stdout) as unknown[]).length;
}

beforeAll(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  poolRoot = join(tmp, 'trees');
  bare = await mkBareRemote(join(tmp, 'remote.git'));
  clone = await mkClone(bare, join(home, 'repos', 'demo'));
  work = await mkClone(bare, join(tmp, 'work'));

  writeFileSync(
    join(home, 'mem', 'repos.json'),
    `${JSON.stringify({ version: 1, demo: { url: bare, mode_default: 'mr', pool_size: 2 } }, null, 2)}\n`,
  );

  const previous = process.env.YAN_HOME;
  process.env.YAN_HOME = home;
  const { Task } = await import('../../src/records/task/index.js');
  Task.create('t1', 'a demo task');
  if (previous === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previous;

  for (const [name, branch] of [['auth', 'feat/auth'], ['proto', 'feat/proto']]) {
    const r = await yan(['unit', 'add', '--task', 't1', '--unit', name, '--repo', 'demo', '--target', 'main', '--branch', branch]);
    expect(r.code, r.out).toBe(0);
  }

  // Both integration branches get a commit of their own and are published, so
  // the sync below is a real three-way merge and not a fast-forward.
  for (const b of ['feat/auth', 'feat/proto']) {
    await fxGit(['checkout', '-b', b, 'origin/main'], work);
    await mkCommit(work, `${b.replace('feat/', '')}.txt`, `work on ${b}`);
    await fxGit(['push', '-u', 'origin', b], work);
    await fxGit(['checkout', 'main'], work);
  }

  // Target moves on.
  await mkCommit(work, 'shared.txt', 'one\ntwo\nthree', 'add shared.txt');
  await fxGit(['push', 'origin', 'main'], work);
});

describe('lease → fetch → merge → push → return', () => {
  it('catches the integration branch up with its target and pushes it', async () => {
    expect(await leases()).toBe(0);

    const r = await yan(['sync', '--task', 't1', '--unit', 'auth']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('caught up with origin/main');

    // It merged: the integration branch on the REMOTE now has target's file as
    // well as its own, so the push really happened.
    await fxGit(['fetch', 'origin'], work);
    expect((await fxGit(['cat-file', '-e', 'origin/feat/auth:shared.txt'], work)).code).toBe(0);
    expect((await fxGit(['cat-file', '-e', 'origin/feat/auth:auth.txt'], work)).code).toBe(0);

    expect(await leases(), 'sync leases a tree only for as long as it is working').toBe(0);
  });

  it('is a no-op the second time, and still returns the tree', async () => {
    const r = await yan(['sync', '--task', 't1', '--unit', 'auth']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('already up to date');
    expect(await leases()).toBe(0);
  });

  it('reports a --json shape `shift new` can read', async () => {
    const r = await yan(['sync', '--task', 't1', '--unit', 'auth', '--json']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).not.toContain('\r');
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.branch).toBe('feat/auth');
    expect(parsed.target).toBe('origin/main');
    expect(parsed.strategy).toBe('merge');
    expect(parsed.moved).toBe(false);
  });
});

describe('a genuine conflict, and the script leaves at once', () => {
  let before = '';

  beforeAll(async () => {
    // feat/proto and main both rewrite the same line of shared.txt. There is no
    // mechanical answer, so this is exactly the case that must be handed over.
    await fxGit(['checkout', 'feat/proto'], work);
    await fxGit(['merge', 'origin/main', '--no-edit'], work);
    await mkCommit(work, 'shared.txt', 'one\nTWO FROM THE UNIT\nthree', 'the unit rewrites line two');
    await fxGit(['push', 'origin', 'feat/proto'], work);

    await fxGit(['checkout', 'main'], work);
    await mkCommit(work, 'shared.txt', 'one\nTWO FROM TARGET\nthree', 'target rewrites line two');
    await fxGit(['push', 'origin', 'main'], work);

    before = (await fxGit(['-C', bare, 'rev-parse', 'feat/proto'])).stdout.trim();
  });

  it('exits 5, names the conflicting paths, and hands off to a shift', async () => {
    const r = await yan(['sync', '--task', 't1', '--unit', 'proto']);
    expect(r.code, 'a conflict has its own exit code, so a caller can tell it from a broken sync').toBe(5);
    expect(r.out).toContain('conflict');
    expect(r.out, 'the conflicting paths are named, so the hand-off is useful').toContain('shared.txt');
    expect(r.out).toContain('dispatch a shift');
    expect(r.out, "git's own merge output is not what the caller is told").not.toContain('CONFLICT (content)');
  });

  it('pushed nothing and gave the tree back, so a conflict cannot wedge the pool', async () => {
    expect((await fxGit(['-C', bare, 'rev-parse', 'feat/proto'])).stdout.trim()).toBe(before);
    expect(await leases(), 'the tree is returned even on the conflict path').toBe(0);

    const r = await yan(['sync', '--task', 't1', '--unit', 'auth']);
    expect(r.code, r.out).toBe(0);
    expect(await leases()).toBe(0);
  });
});

describe('the pool-full trap', () => {
  it('says the pool is full, not that sync failed', async () => {
    // pool_size is 2 here, so two leases are enough to fill it.
    expect((await yan(['tree', 'get', '--repo', 'demo', '--base', 'main', '--branch', 'yan/t1-x-s1', '--holder', 't1/x/s1'])).code).toBe(0);
    expect((await yan(['tree', 'get', '--repo', 'demo', '--base', 'main', '--branch', 'yan/t1-x-s2', '--holder', 't1/x/s2'])).code).toBe(0);
    expect(await leases()).toBe(2);

    const r = await yan(['sync', '--task', 't1', '--unit', 'auth']);
    expect(r.code, 'a full pool has its own exit code').toBe(3);
    expect(r.out).toContain('pool is full');
    expect(r.out).toContain('cannot start a new shift');
    expect(r.out, 'THE trap: the reader must not go looking for a synchronisation problem').not.toContain('sync failed');
    expect(r.out, 'it says where to look instead').toContain('yan tree status');

    await yan(['tree', 'return', '--repo', 'demo', '--slot', '1']);
    await yan(['tree', 'return', '--repo', 'demo', '--slot', '2']);
  });
});

describe('what it refuses before it touches anything', () => {
  it('needs a task, a unit, and a strategy it understands', async () => {
    expect((await yan(['sync', '--task', 't1'])).out).toContain('--unit is required');
    const bad = await yan(['sync', '--task', 't1', '--unit', 'auth', '--strategy', 'squash']);
    expect(bad.code, 'sync rebases or merges; nothing else').toBe(2);
    expect(bad.out).toContain('merge');
    expect((await yan(['sync', '--task', 'nope', '--unit', 'auth'])).out).toContain('no such task');
  });

  it('refuses a unit with no integration branch', async () => {
    const previous = process.env.YAN_HOME;
    process.env.YAN_HOME = home;
    const { Task } = await import('../../src/records/task/index.js');
    new Task('t1').addUnit('nobranch', 'demo', 'main');
    if (previous === undefined) delete process.env.YAN_HOME;
    else process.env.YAN_HOME = previous;

    const r = await yan(['sync', '--task', 't1', '--unit', 'nobranch']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('no integration branch yet');
  });
});

describe('yan never resolves a conflict, and the source says so', () => {
  // One of the four ordering regressions is `yan sync` quietly gaining the
  // ability to fix a conflict itself. It is not a thing that fails loudly when
  // it goes wrong, so the shape is pinned here as well as in the behaviour
  // test: no continue, no theirs/ours, no rerere.
  const source = readFileSync(join(repoRoot, 'src', 'cli', 'sync.ts'), 'utf8');

  it.each(["'--continue'", '--theirs', '--ours', 'rerere'])('contains no %s', (bad) => {
    expect(source).not.toContain(bad);
  });
});
