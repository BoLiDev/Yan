import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkClone,
  mkCommit,
  mkTempDir,
  mkYanHome,
  registerRepo,
} from '../helpers/fixtures.js';
import { clockOut, type Closer, type DoneDeps } from '../../src/cli/shift.js';
import { Task } from '../../src/records/task/index.js';
import { WorktreePool } from '../../src/externals/worktree/index.js';
import type { MrState } from '../../src/externals/remote-git/index.js';

/**
 * `yan shift done` against real git and the real pool, in the one case that
 * actually breaks: A squash merge.
 *
 * When the internal merge request is squash-merged, the integration branch does
 * not contain the shift branch's HEAD. Two things follow, and both are in
 * worktree.md §7:
 *
 *   1. An ancestry check would answer "not merged" about work that landed an
 *      hour ago. This test asserts that ancestry really does say no here, and
 *      that `yan shift done` clocks the shift out anyway, because it asked the
 *      host.
 *
 *   2. Deleting the remote shift branch removes its remote-tracking ref — which
 *      a worktree shares with its main clone — so `git branch -r --contains
 *      HEAD` goes empty and the pool's orphan-commit guard refuses to take the
 *      tree back. There is no force flag anywhere, so the slot would be
 *      stranded for good. The control below does exactly that, in the wrong
 *      order, and shows the refusal.
 *
 * Only the host is a stand-in: whether an MR merged cannot be asked of a local
 * bare repository, and nothing here may touch the network.
 */

afterAll(cleanupTempDirs);

let home = '';
let bare = '';
let clone = '';
let poolRoot = '';
let previousHome: string | undefined;
let previousPool: string | undefined;

const MR = 'https://forge.invalid/acme/widget/-/merge_requests/31';

const silentTerminal: Closer = { close: () => {}, clearPaneTitle: () => {} };

function deps(says: MrState = 'merged'): DoneDeps {
  return { terminal: silentTerminal, mrStateOf: (): MrState => says };
}

/** A shift as `yan shift new` leaves one: a leased tree on its own pushed branch. */
async function dispatch(sid: string): Promise<string> {
  const branch = `yan/t042-auth-${sid}`;
  const grant = new WorktreePool(clone).get(4, 'feat/auth', branch, `t042/auth/${sid}`);

  await mkCommit(grant.path, join('apps', 'auth', `${sid}.txt`), `work from ${sid}`, `${sid}: parse the header`);
  await fxGit(['-C', grant.path, 'push', '-u', 'origin', branch]);

  const run = join(home, 'tasks', 't042', 'shifts', sid, 'run');
  mkdirSync(run, { recursive: true });
  writeFileSync(
    join(run, 'meta.json'),
    `${JSON.stringify({
      version: 1, task: 't042', sid, unit: 'auth', repo: 'widget',
      branch, base: 'feat/auth', tree: grant.path, clone,
      holder: `t042/auth/${sid}`, lease_id: grant.lease_id, agent: 'claude',
      container: 'w1', pane: 'w1:p7', mr: MR,
    })}\n`,
  );
  return grant.path;
}

/**
 * Land a branch on feat/auth the way a squash merge does: the change arrives as
 * a new commit and the branch's own HEAD is nowhere in the integration
 * branch's history.
 */
async function squashMerge(branch: string): Promise<void> {
  const scratch = await mkClone(bare, join(mkTempDir(), 'scratch'));
  await fxGit(['-C', scratch, 'checkout', 'feat/auth']);
  await fxGit(['-C', scratch, 'merge', '--squash', `origin/${branch}`]);
  await fxGit(['-C', scratch, 'commit', '-m', `squash ${branch}`]);
  await fxGit(['-C', scratch, 'push', 'origin', 'feat/auth']);
  rmSync(scratch, { recursive: true, force: true });
  await fxGit(['-C', clone, 'fetch', '--prune', 'origin']);
}

async function remoteHas(branch: string): Promise<boolean> {
  return (await fxGit(['-C', clone, 'ls-remote', '--heads', 'origin', `refs/heads/${branch}`])).stdout.trim() !== '';
}

function heldBy(holder: string): string {
  return new WorktreePool(clone).status().find((l) => l.holder === holder)?.path ?? '';
}

beforeAll(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  poolRoot = join(tmp, 'trees');
  previousHome = process.env.YAN_HOME;
  previousPool = process.env.YAN_POOL_ROOT;
  process.env.YAN_HOME = home;
  process.env.YAN_POOL_ROOT = poolRoot;

  bare = await mkBareRemote(join(tmp, 'remote.git'));
  clone = await mkClone(bare, join(home, 'repos', 'widget'));
  // A clone is where the registry says it is now, not where a convention put
  // it (v3 td repos.md §2). The path does not change; only the reason yan
  // can find it.
  registerRepo(home, 'widget', clone, { url: bare });

  // The integration branch this round works on.
  await fxGit(['-C', clone, 'checkout', '-b', 'feat/auth']);
  await fxGit(['-C', clone, 'push', '-u', 'origin', 'feat/auth']);
  await fxGit(['-C', clone, 'checkout', 'main']);

  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'widget', 'master', { branch: 'feat/auth', scope: ['apps/auth'] });
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
  if (previousPool === undefined) delete process.env.YAN_POOL_ROOT;
  else process.env.YAN_POOL_ROOT = previousPool;
});

describe('a squash-merged shift clocks out', () => {
  let tree = '';

  beforeAll(async () => {
    tree = await dispatch('s1');
    await squashMerge('yan/t042-auth-s1');
  });

  it('is exactly the case where ancestry would say the wrong thing', async () => {
    expect(await remoteHas('yan/t042-auth-s1')).toBe(true);
    expect(
      (await fxGit(['-C', tree, 'merge-base', '--is-ancestor', 'HEAD', 'origin/feat/auth'])).code,
      'after a squash merge the integration branch does NOT contain the shift HEAD',
    ).not.toBe(0);
    // But the work did land: the file is on the integration branch.
    expect((await fxGit(['-C', clone, 'show', 'origin/feat/auth:apps/auth/s1.txt'])).stdout).toContain('work from s1');
  });

  it('clocks out anyway, because it asked the host', async () => {
    clockOut('s1', {}, deps());

    expect(existsSync(join(home, 'tasks', 't042', 'shifts', 's1', 'run')), 'run/ is gone').toBe(false);
    expect(existsSync(join(home, 'tasks', 't042', 'shifts', 's1', 'outcome.md'))).toBe(true);

    expect(heldBy('t042/auth/s1'), 'the slot is free again').toBe('');
    expect((await fxGit(['-C', tree, 'status', '--porcelain'])).stdout.trim(), 'the tree was reset and cleaned').toBe('');
    expect(await remoteHas('yan/t042-auth-s1'), 'the merged shift branch is deleted on origin - last').toBe(false);
  });
});

describe('the control: the same situation in the WRONG order', () => {
  it('strands the slot, which is why the branch is deleted last', async () => {
    const tree = await dispatch('s2');
    await squashMerge('yan/t042-auth-s2');

    // This is the step that must not come first.
    await fxGit(['-C', clone, 'push', 'origin', '--delete', 'yan/t042-auth-s2']);
    await fxGit(['-C', clone, 'fetch', '--prune', 'origin']);

    expect(
      (await fxGit(['-C', tree, 'branch', '-r', '--contains', 'HEAD'])).stdout.trim(),
      'deleting the branch takes the remote-tracking ref with it, and a worktree shares refs with its clone',
    ).toBe('');

    let refused = '';
    try {
      new WorktreePool(clone).return(tree);
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    expect(refused, 'the orphan-commit guard refuses, exactly as worktree.md §7 says it would').toContain(
      'no remote branch contains HEAD',
    );
    expect(heldBy('t042/auth/s2'), 'and the slot stays taken').not.toBe('');

    // Put it back the only way that is left, so the fixture tears down cleanly.
    await fxGit(['-C', tree, 'push', '-u', 'origin', 'yan/t042-auth-s2']);
    new WorktreePool(clone).return(tree);
  });
});

describe('an interrupted teardown can be finished', () => {
  it('derives which shift it was from the pool, and says what it is doing', async () => {
    // The documented order deletes run/ (step 4) before returning the tree
    // (step 5). So a return that refuses - or a kill, or a sleeping laptop -
    // leaves run/ gone, the tree still leased and the remote branch still
    // there, with nothing left in $YAN_HOME to say which shift they belonged
    // to. Observed for real: the tree came back dirty because the install step
    // the brief mandates had generated an untracked file.
    const tree = await dispatch('s5');
    await fxGit(['-C', tree, 'commit', '--allow-empty', '-m', 'work for s5']);
    await fxGit(['-C', tree, 'push', 'origin', 'yan/t042-auth-s5']);
    await squashMerge('yan/t042-auth-s5');

    // Make the tree dirty, exactly as a generated lockfile does.
    writeFileSync(join(tree, 'leftover.txt'), 'generated\n');

    let refused = '';
    try {
      clockOut('s5', { mr: MR }, deps());
    } catch (err) {
      refused = err instanceof Error ? err.message : String(err);
    }
    expect(refused, 'a dirty tree must refuse, so the teardown stops at step 5').not.toBe('');
    expect(refused, 'and it must not delete the branch').toContain('has NOT been deleted');

    // The half-torn-down state: run/ gone, tree still leased, branch still there.
    expect(existsSync(join(home, 'tasks', 't042', 'shifts', 's5', 'run')), 'run/ was already deleted').toBe(false);
    expect(heldBy('t042/auth/s5'), 'the tree is still leased').not.toBe('');
    expect(await remoteHas('yan/t042-auth-s5')).toBe(true);

    // Now resolve what made it refuse, as an operator would, and re-run.
    rmSync(join(tree, 'leftover.txt'));
    const result = clockOut('s5', {}, deps());
    expect(result.tree_returned).toBe(true);

    expect(heldBy('t042/auth/s5'), 'the tree is back in the pool').toBe('');
    expect(await remoteHas('yan/t042-auth-s5'), 'and only now is the remote branch gone').toBe(false);
  });
});
