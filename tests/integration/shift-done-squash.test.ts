import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
import { liveShift, seedT042 } from '../helpers/records.js';
import { clockOut, type ClockOutDeps } from '../../src/cli/shift/done.js';
import type { Closer } from '../../src/cli/shared/terminal.js';
import { WorktreePool } from '../../src/externals/worktree/index.js';
import type { MrState } from '../../src/externals/remote-git/index.js';

/**
 * `yan shift done` against real git and the real pool, in the case that
 * actually breaks: a squash merge, after which the integration branch does not
 * contain the shift branch's HEAD.
 *
 * Two things follow. Ancestry answers "not merged" about work that landed an
 * hour ago, so the host has to be asked. And deleting the remote branch first
 * empties `branch -r --contains HEAD`, so the orphan-commit guard refuses the
 * return and strands the slot — the control below does exactly that.
 *
 * Only the host is a stand-in: whether an MR merged cannot be asked of a local
 * bare repository, and nothing here may touch the network.
 */

afterAll(cleanupTempDirs);

let home = '';
let bare = '';
let clone = '';
let poolRoot = '';
let previousPool: string | undefined;

const MR = 'https://forge.invalid/acme/widget/-/merge_requests/31';

const silentTerminal: Closer = { close: () => {}, clearPaneTitle: () => {} };

function deps(says: MrState = 'merged'): ClockOutDeps {
  return { terminal: silentTerminal, mrStateOf: (): MrState => says };
}

/** A shift as `yan shift new` leaves one: a leased tree on its own pushed branch. */
async function dispatch(sid: string): Promise<string> {
  const branch = `yan/t042-auth-${sid}`;
  const grant = new WorktreePool(clone).get(4, 'feat/auth', branch, `t042/auth/${sid}`);

  await mkCommit(grant.path, join('apps', 'auth', `${sid}.txt`), `work from ${sid}`, `${sid}: parse the header`);
  await fxGit(['-C', grant.path, 'push', '-u', 'origin', branch]);

  liveShift(home, 't042', sid, {
    task: 't042', sid, unit: 'auth', repo: 'widget',
    branch, base: 'feat/auth', tree: grant.path, clone,
    holder: `t042/auth/${sid}`, lease_id: grant.lease_id, agent: 'claude',
    container: 'w1', pane: 'w1:p7', mr: MR,
  });
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
  previousPool = process.env.YAN_POOL_ROOT;
  process.env.YAN_POOL_ROOT = poolRoot;

  bare = await mkBareRemote(join(tmp, 'remote.git'));
  clone = await mkClone(bare, join(home, 'repos', 'widget'));
  registerRepo(home, 'widget', clone, { url: bare });

  // The integration branch this round works on.
  await fxGit(['-C', clone, 'checkout', '-b', 'feat/auth']);
  await fxGit(['-C', clone, 'push', '-u', 'origin', 'feat/auth']);
  await fxGit(['-C', clone, 'checkout', 'main']);

  seedT042({ repo: 'widget' });
});

afterAll(() => {
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
    expect(refused, 'the orphan-commit guard refuses rather than destroy the commits').toContain(
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
    // run/ is deleted before the tree is returned, so a refused return leaves
    // run/ gone with the tree still leased and nothing to say whose it was.
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
    expect(result.scenario, 'teardown.json kept what run/ took with it').toBe('coding');
    expect(result.mr_state).toBe('merged');
    expect(result.mr).toBe(MR);

    expect(heldBy('t042/auth/s5'), 'the tree is back in the pool').toBe('');
    expect(await remoteHas('yan/t042-auth-s5'), 'and only now is the remote branch gone').toBe(false);
  });
});

/**
 * An explore shift whose teardown stops at the tree return, as a dirty tree
 * makes it: run/ is gone by the time it is run again, and the scenario with it
 * unless something outside run/ kept it.
 */
async function interruptedExplore(sid: string, options: { push: boolean }): Promise<{ shiftDir: string; watching: ClockOutDeps; dropped: string[] }> {
  // An explore shift is told not to push; `push` is one that did anyway.
  const branch = `yan/t042-auth-${sid}`;
  const grant = new WorktreePool(clone).get(4, 'feat/auth', branch, `t042/auth/${sid}`);
  if (options.push) {
    await mkCommit(grant.path, join('apps', 'auth', `${sid}.txt`), `probe from ${sid}`, `${sid}: try it`);
    await fxGit(['-C', grant.path, 'push', '-u', 'origin', branch]);
  }
  const shiftDir = dirname(liveShift(home, 't042', sid, {
    task: 't042', sid, unit: 'auth', repo: 'widget', scenario: 'explore',
    branch, base: 'feat/auth', tree: grant.path, clone,
    holder: `t042/auth/${sid}`, lease_id: grant.lease_id, agent: 'claude',
    container: 'w1', pane: 'w1:p8',
  }));
  writeFileSync(join(shiftDir, 'outcome.md'), `# ${sid} auth\n\nThe header is parsed in two places: https://example.invalid/notes\n`);
  writeFileSync(join(grant.path, 'leftover.txt'), 'generated\n');

  const dropped: string[] = [];
  const watching: ClockOutDeps = { ...deps(), deleteBranch: (_c, b) => { dropped.push(b); return true; } };

  expect(() => clockOut(sid, {}, watching), 'a dirty tree stops the teardown at the return').toThrow();
  expect(existsSync(join(shiftDir, 'run')), 'run/ is gone').toBe(false);
  expect(heldBy(`t042/auth/${sid}`)).not.toBe('');

  rmSync(join(grant.path, 'leftover.txt'));
  return { shiftDir, watching, dropped };
}

describe('an interrupted teardown of an explore shift', () => {
  it('still knows it was explore: no merge claimed, and none reported unknown', async () => {
    const { watching, dropped } = await interruptedExplore('s6', { push: false });
    const result = clockOut('s6', {}, watching);

    expect(result.tree_returned).toBe(true);
    expect(dropped, 'an explore shift has no branch of yan\'s to delete').toEqual([]);
    expect(result.branch_deleted).toBe(false);
    expect(result.scenario).toBe('explore');
    expect(result.mr_state).toBe('none');
    expect(result.mr, 'a URL in its report is not a merge request').toBe('');
  });

  it('leaves a branch it pushed on origin, as the teardown that did not stop would have', async () => {
    const { watching, dropped } = await interruptedExplore('s7', { push: true });
    const result = clockOut('s7', {}, watching);

    expect(result.tree_returned).toBe(true);
    expect(dropped).toEqual([]);
    expect(result.branch_deleted).toBe(false);
    expect(await remoteHas('yan/t042-auth-s7'), 'what it pushed is left for somebody to look at').toBe(true);
    expect(result.scenario).toBe('explore');
  });

  it('falls back to unknown for a shift dispatched before teardown.json', async () => {
    const { shiftDir, watching, dropped } = await interruptedExplore('s8', { push: false });
    rmSync(join(shiftDir, 'teardown.json'));
    const result = clockOut('s8', {}, watching);

    expect(result.tree_returned).toBe(true);
    expect(dropped, 'origin has no such branch, so there is nothing to delete').toEqual([]);
    expect(result.branch_deleted).toBe(false);
    expect(result.mr_state).toBe('unknown');
    expect(result.scenario).toBe('unknown');
    expect(result.mr, 'the only place left to look is outcome.md').toBe('https://example.invalid/notes');
  });
});
