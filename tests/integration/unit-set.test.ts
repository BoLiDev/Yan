import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkCommit,
  mkClone,
  mkTempDir,
  mkYanHome,
  registerRepo,
  runYan,
} from '../helpers/fixtures.js';
import { setUnit } from '../../src/cli/unit.js';
import { Task } from '../../src/records/task/index.js';
import type { MrState } from '../../src/externals/remote-git/index.js';

/**
 * `yan unit set`. Two things are pinned here:
 *
 *   The rotation is all of it or none of it, so every refusal path is checked
 *   against a byte-for-byte copy of task.json.
 *
 *   `end` is looked up rather than remembered, through an injected reader so
 *   no network is involved.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let bare = '';
let previousHome: string | undefined;

const MR = 'https://forge.invalid/acme/demo/-/merge_requests/7';

/** What the host would say, and whether it was asked at all. */
let hostSays: MrState = 'unknown';
let hostAsked = 0;
const host = (): MrState => {
  hostAsked += 1;
  return hostSays;
};

function taskFile(): string {
  return join(home, 'tasks', 't1', 'task.json');
}

function doc(): { units: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(taskFile(), 'utf8')) as { units: Record<string, unknown>[] };
}

function unitField(name: string, field: string): unknown {
  return doc().units.find((u) => u.name === name)?.[field] ?? '';
}

function history(name: string): Record<string, string>[] {
  return (doc().units.find((u) => u.name === name)?.history ?? []) as Record<string, string>[];
}

/** Run `setUnit` and report the way the command layer would: code plus message. */
function run(options: Parameters<typeof setUnit>[0]): { code: number; message: string } {
  try {
    setUnit(options, host);
    return { code: 0, message: '' };
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { code: e.exitCode ?? 1, message: e.message ?? '' };
  }
}

let snapshot = '';
function snap(): void {
  snapshot = readFileSync(taskFile(), 'utf8');
}
function assertUntouched(): void {
  expect(readFileSync(taskFile(), 'utf8'), 'a refusal must leave task.json exactly as it was').toBe(snapshot);
}

beforeAll(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  bare = await mkBareRemote(join(tmp, 'remote.git'));
  clone = await mkClone(bare, join(home, 'repos', 'demo'));
  registerRepo(home, 'demo', clone);

  previousHome = process.env.YAN_HOME;
  process.env.YAN_HOME = home;
  Task.create('t1', 'a demo task');
  for (const name of ['auth', 'proto']) {
    const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', name, '--repo', 'demo', '--target', 'main']);
    expect(r.code, r.out).toBe(0);
  }
  expect(unitField('auth', 'branch')).toBe('yan/t1-auth-r1');
});

afterEach(() => {
  hostAsked = 0;
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('what it refuses before it touches anything', () => {
  it('changes nothing unless asked, and names the missing identifiers', async () => {
    const r = await runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'auth']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('nothing to change');
    expect((await runYan(home, ['unit', 'set', '--unit', 'auth', '--branch', 'x'])).out).toContain('--task is required');
  });

  it("takes 'delivered' or 'abandoned' for --end; the host's own words never leak in", async () => {
    const r = await runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'auth', '--end', 'merged', '--branch', 'x']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('delivered');
  });

  it('refuses --end without --branch: it says how the round being replaced finished', async () => {
    const r = await runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'auth', '--end', 'delivered', '--target', 'main']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('only applies to --branch');
  });
});

describe('a round with nothing on it is replaced without an interrogation', () => {
  it('records it as `unused` and asks for no reason at all', () => {
    const r = run({ task: 't1', unit: 'auth', branch: 'feat/auth-r2', at: '2026-08-25' });
    expect(r.code, r.message).toBe(0);

    const h = history('auth');
    expect(h).toHaveLength(1);
    expect(h[0]).toEqual({
      branch: 'yan/t1-auth-r1',
      target: 'main',
      at: '2026-08-25',
      // `unused`, not `abandoned`: there is nothing to explain.
      end: 'unused',
    });
    expect(h[0].mr, 'a round that never opened an MR stores no mr field').toBeUndefined();
    expect(unitField('auth', 'branch')).toBe('feat/auth-r2');
    expect(unitField('auth', 'mr')).toBe('');
    // The host was never asked: there was no MR to ask about.
    expect(hostAsked).toBe(0);
  });

  it("cuts the successor from the OLD branch, so nothing that was there is lost", async () => {
    expect((await fxGit(['-C', clone, 'rev-parse', 'feat/auth-r2'])).stdout.trim()).toBe(
      (await fxGit(['-C', clone, 'rev-parse', 'yan/t1-auth-r1'])).stdout.trim(),
    );
  });

  it('says in log.md what happened and what was carried', () => {
    const log = readFileSync(join(home, 'tasks', 't1', 'log.md'), 'utf8');
    expect(log).toContain('auth  unused yan/t1-auth-r1 → feat/auth-r2');
    expect(log).toContain('no merge request was ever opened for it');
    // Nothing to carry: the successor was cut from the branch it replaces.
    expect(log).toContain('nothing to carry forward');
  });
});

describe('an open MR does not block the rotation any more', () => {
  it('rotates, records the round as `unknown`, and says the MR is still open', async () => {
    new Task('t1').unit('auth').set('mr', MR);
    hostSays = 'open';

    const r = run({ task: 't1', unit: 'auth', branch: 'feat/auth-r3', at: '2026-08-26' });
    expect(r.code, r.message).toBe(0);

    const h = history('auth');
    expect(h).toHaveLength(2);
    // Rotating away from an open MR is allowed, and says so loudly.
    expect(h[1].end).toBe('unknown');
    expect(h[1].mr, 'it is awkward to look up once the branch is gone').toBe(MR);
    expect(unitField('auth', 'branch')).toBe('feat/auth-r3');
    expect((await fxGit(['-C', clone, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/auth-r3'])).code).toBe(0);

    const log = readFileSync(join(home, 'tasks', 't1', 'log.md'), 'utf8');
    expect(log).toContain('was still open when the round was replaced');
  });

  it("still takes `user`'s own answer through --end, and needs no reason for it", () => {
    new Task('t1').unit('proto').set('mr', MR);
    hostSays = 'open';
    const r = run({ task: 't1', unit: 'proto', branch: 'feat/proto-r2', end: 'abandoned' });
    expect(r.code, r.message).toBe(0);
    expect(history('proto')[0].end).toBe('abandoned');
    // --end short-circuits the lookup entirely: the answer is already `user`'s.
    expect(hostAsked).toBe(0);
  });
});

describe('a host that cannot answer is recorded, not obeyed', () => {
  it('writes `unknown` and carries on', () => {
    new Task('t1').unit('auth').set('mr', MR);
    hostSays = 'unknown';

    const r = run({ task: 't1', unit: 'auth', branch: 'feat/auth-r4' });
    expect(r.code, r.message).toBe(0);
    const h = history('auth');
    expect(h[2].end).toBe('unknown');
    expect(readFileSync(join(home, 'tasks', 't1', 'log.md'), 'utf8')).toContain(
      'could not say what became of',
    );
  });
});

describe('merged means delivered', () => {
  it('starts the next round from target, which already contains the old one', async () => {
    hostSays = 'merged';
    new Task('t1').unit('auth').set('mr', MR);
    const r = run({ task: 't1', unit: 'auth', branch: 'feat/auth-r5', at: '2026-08-27' });
    expect(r.code, r.message).toBe(0);

    const h = history('auth');
    expect(h[3].end).toBe('delivered');
    expect(h[3].at).toBe('2026-08-27');
    expect(unitField('auth', 'branch')).toBe('feat/auth-r5');
    expect((await fxGit(['-C', clone, 'rev-parse', 'feat/auth-r5'])).stdout.trim()).toBe(
      (await fxGit(['-C', clone, 'rev-parse', 'origin/main'])).stdout.trim(),
    );
    expect(readFileSync(join(home, 'tasks', 't1', 'log.md'), 'utf8')).toContain(
      'auth  delivered feat/auth-r4 → feat/auth-r5',
    );
  });

  it('never asks the host about a round whose conclusion is already written', () => {
    const h = history('auth');
    expect(h[0].end).toBe('unused');
    expect(h[1].end).toBe('unknown');
  });
});

describe('closed means abandoned', () => {
  it('is decided by the host, not by the caller', () => {
    new Task('t1').unit('proto').set('mr', MR);
    hostSays = 'closed';
    const r = run({
      task: 't1',
      unit: 'proto',
      branch: 'feat/proto-r3',
      reason: 'the RFC was rejected upstream',
    });
    expect(r.code, r.message).toBe(0);
    expect(history('proto')[1].end).toBe('abandoned');
    expect(hostAsked).toBe(1);
  });
});

describe("the built-in default carries the NEXT round's number", () => {
  it('counts history AFTER this rotation appends to it', () => {
    // Off by one and the built-in name would collide with the branch being
    // replaced.
    expect(history('proto')).toHaveLength(2);
    const r = run({
      task: 't1',
      unit: 'proto',
      branch: true,
      reason: 'starting the third round from scratch',
    });
    expect(r.code, r.message).toBe(0);
    expect(unitField('proto', 'branch'), 'r1 and r2 are already in history, so the default is r3').toBe('yan/t1-proto-r4');
    expect(history('proto')).toHaveLength(3);
    expect(history('proto')[2].branch).toBe('feat/proto-r3');
  });
});

describe('the three plain scalars, each of them a decision', () => {
  it('sets target, mode and scope, and refuses a mode outside the closed set', async () => {
    expect((await runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'proto', '--target', 'release/8'])).code).toBe(0);
    expect(unitField('proto', 'target')).toBe('release/8');

    expect((await runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'proto', '--mode', 'branch'])).code).toBe(0);
    expect(unitField('proto', 'mode')).toBe('branch');

    expect((await runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'proto', '--mode', 'sideways'])).code).not.toBe(0);

    expect((await runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'proto', '--scope', 'libs/proto', '--scope', 'libs/shared'])).code).toBe(0);
    expect(unitField('proto', 'scope')).toEqual(['libs/proto', 'libs/shared']);
  });
});

describe('the same branch twice is not a new round', () => {
  it('is refused, and moves nothing', () => {
    snap();
    const r = run({ task: 't1', unit: 'auth', branch: 'feat/auth-r5', end: 'delivered' });
    expect(r.code).toBe(2);
    expect(r.message).toContain('same as the current one');
    assertUntouched();
  });
});

describe('history is append-only, and the whole file is still valid', () => {
  it('has never rewritten history[0]', () => {
    expect(history('auth')).toHaveLength(4);
    expect(history('auth')[0].branch).toBe('yan/t1-auth-r1');
  });
});

/**
 * Carrying the replaced round forward: the successor is cut elsewhere, so its
 * commits are not on it. Done in the main clone with no worktree, which is a
 * ref-and-object write and never a working-tree change.
 */
describe('the work on the old round is carried forward', () => {
  let work = '';

  beforeAll(async () => {
    work = await mkClone(bare, join(mkTempDir('yan-work-'), 'work'));
    await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'carry', '--repo', 'demo', '--target', 'main']);

    // Real work on the round that is about to be replaced.
    await fxGit(['checkout', '-b', 'yan/t1-carry-r1', 'origin/main'], work);
    await mkCommit(work, 'carried.txt', 'work nobody wants to lose');
    await fxGit(['push', '-u', 'origin', 'yan/t1-carry-r1'], work);
    await fxGit(['fetch', 'origin'], clone);
    await fxGit(['branch', '--force', 'yan/t1-carry-r1', 'origin/yan/t1-carry-r1'], clone);
  });

  it('merges the old branch into the new one, in the main clone, with no worktree', async () => {
    // The successor is cut from target, which does not contain the old work —
    // exactly the shape a `branch-create` hook produces.
    const r = run({ task: 't1', unit: 'carry', branch: 'feat/carry-r2', base: 'main' });
    expect(r.code, r.message).toBe(0);

    const reachable = await fxGit(['-C', clone, 'merge-base', '--is-ancestor', 'yan/t1-carry-r1', 'feat/carry-r2']);
    expect(reachable.code, 'the abandoned round is an ancestor of its successor now').toBe(0);
    expect((await fxGit(['-C', clone, 'cat-file', '-e', 'feat/carry-r2:carried.txt'])).code).toBe(0);

    // The rule this must not break: the main clone's working tree never moved.
    expect((await fxGit(['-C', clone, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('main');
    expect((await fxGit(['-C', clone, 'status', '--porcelain'])).stdout.trim()).toBe('');

    expect(readFileSync(join(home, 'tasks', 't1', 'log.md'), 'utf8')).toContain('carried 1 commit(s)');
  });

  it('pushes what it carried, so the branch on the remote has it too', async () => {
    await fxGit(['fetch', 'origin'], work);
    expect((await fxGit(['-C', bare, 'cat-file', '-e', 'feat/carry-r2:carried.txt'])).code).toBe(0);
  });

  it('a conflict is reported loudly and does not undo the rotation', async () => {
    // The same file, written differently on target and on the round being
    // replaced. The successor is cut from target, so the merge has no
    // mechanical answer and git says so.
    await fxGit(['checkout', '-b', 'side', 'origin/main'], work);
    await mkCommit(work, 'clash.txt', 'from the old round');
    await fxGit(['push', '-u', 'origin', 'side'], work);

    await fxGit(['checkout', 'main'], work);
    await fxGit(['pull', '--ff-only'], work);
    await mkCommit(work, 'clash.txt', 'from target');
    await fxGit(['push', 'origin', 'main'], work);

    await fxGit(['fetch', 'origin'], clone);
    await fxGit(['branch', '--force', 'side', 'origin/side'], clone);
    new Task('t1').unit('carry').set('branch', 'side');

    const r = run({ task: 't1', unit: 'carry', branch: 'feat/carry-r3', base: 'main' });
    expect(r.code, 'a conflict does not fail the rotation: the branch and the history are right').toBe(0);
    expect(unitField('carry', 'branch')).toBe('feat/carry-r3');

    const log = readFileSync(join(home, 'tasks', 't1', 'log.md'), 'utf8');
    expect(log).toContain('did NOT carry forward');
    // And the work is still on the branch it was on, reachable by name.
    expect((await fxGit(['-C', clone, 'cat-file', '-e', 'side:clash.txt'])).code).toBe(0);
  });
});
