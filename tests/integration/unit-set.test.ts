import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkClone,
  mkTempDir,
  mkYanHome,
  runYan,
} from '../helpers/fixtures.js';
import { setUnit } from '../../src/cli/unit.js';
import { Task } from '../../src/records/task/index.js';
import type { MrState } from '../../src/externals/remote-git/index.js';

/**
 * `yan unit set`, ported from `tests/integration/yan-unit-set.test.sh` and
 * `tests/unit/yan-unit-args.test.sh`.
 *
 * Phase 7 Trace: "`unit set --branch` archives the old round into `history[]`
 * atomically."
 *
 * Two things are pinned here, and they pull in opposite directions.
 *
 *   All of it, or none of it. The rotation is decide `end` → append the old
 *   branch/target/mr to history[] with `at` → overwrite the current fields →
 *   log. A file left with the old round archived but the new branch not yet
 *   recorded would be a round that exists twice. So the refusal paths are
 *   checked against a byte-for-byte copy of task.json: nothing moved.
 *
 *   `end` is looked up, not remembered. merged → delivered; closed, or no mr at
 *   all → abandoned; still open or unreachable → ASK `user`, and yan refuses to
 *   decide. The host answers through an injected reader rather than a stub
 *   binary on PATH, so `open → merged` is reproducible and no network is
 *   involved — the same shape `yan wait` uses for its two sources.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
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

beforeAll(() => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  clone = mkClone(mkBareRemote(join(tmp, 'remote.git')), join(home, 'repos', 'demo'));

  previousHome = process.env.YAN_HOME;
  process.env.YAN_HOME = home;
  Task.create('t1', 'a demo task');
  for (const name of ['auth', 'proto']) {
    const r = runYan(home, ['unit', 'add', '--task', 't1', '--unit', name, '--repo', 'demo', '--target', 'main']);
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
  it('changes nothing unless asked, and names the missing identifiers', () => {
    const r = runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'auth']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('nothing to change');
    expect(runYan(home, ['unit', 'set', '--unit', 'auth', '--branch', 'x']).out).toContain('--task is required');
  });

  it("takes 'delivered' or 'abandoned' for --end; the host's own words never leak in", () => {
    const r = runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'auth', '--end', 'merged', '--branch', 'x']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('delivered');
  });

  it('refuses --end without --branch: it says how the round being replaced finished', () => {
    const r = runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'auth', '--end', 'delivered', '--target', 'main']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('only applies to --branch');
  });
});

describe('a round with no MR was never delivered, and it has to say why', () => {
  it('refuses to abandon without a reason, and moves nothing', () => {
    snap();
    const r = run({ task: 't1', unit: 'auth', branch: 'feat/auth-r2' });
    expect(r.code).toBe(2);
    expect(r.message).toContain('--reason is required');
    assertUntouched();
    // The host was never asked: there was no MR to ask about, so there was
    // nothing that could have been delivered.
    expect(hostAsked).toBe(0);
  });

  it('archives the old round with `at`, and the current fields have already moved on', () => {
    const r = run({
      task: 't1',
      unit: 'auth',
      branch: 'feat/auth-r2',
      reason: 'the approach was wrong, starting again from the interface',
      at: '2026-08-25',
    });
    expect(r.code, r.message).toBe(0);

    const h = history('auth');
    expect(h).toHaveLength(1);
    expect(h[0]).toEqual({
      branch: 'yan/t1-auth-r1',
      target: 'main',
      at: '2026-08-25',
      end: 'abandoned',
    });
    expect(h[0].mr, 'a round that never opened an MR stores no mr field').toBeUndefined();
    expect(unitField('auth', 'branch')).toBe('feat/auth-r2');
    expect(unitField('auth', 'mr')).toBe('');
    expect(hostAsked).toBe(0);
  });

  it("cuts the abandoned round's successor from the OLD branch, so the work is still reachable", () => {
    expect(fxGit(['-C', clone, 'rev-parse', 'feat/auth-r2']).stdout.trim()).toBe(
      fxGit(['-C', clone, 'rev-parse', 'yan/t1-auth-r1']).stdout.trim(),
    );
  });

  it('says why in log.md — the one thing nobody remembers later', () => {
    const log = readFileSync(join(home, 'tasks', 't1', 'log.md'), 'utf8');
    expect(log).toContain('auth  abandoned yan/t1-auth-r1 → feat/auth-r2');
    expect(log).toContain('the approach was wrong, starting again from the interface');
    expect(log).toContain('based on yan/t1-auth-r1');
  });
});

describe('an open MR is not an ending, and yan refuses to decide', () => {
  it('exits 4, changes nothing, and creates no branch', () => {
    new Task('t1').unit('auth').set('mr', MR);
    snap();
    hostSays = 'open';

    const r = run({ task: 't1', unit: 'auth', branch: 'feat/auth-r3' });
    expect(r.code, "still open means 'ask user', and that is its own exit code").toBe(4);
    expect(r.message).toContain('NOT OVER');
    expect(r.message).toContain("Ask 'user'");
    expect(r.message).toContain('Nothing was changed');
    assertUntouched();
    expect(fxGit(['-C', clone, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/auth-r3']).code).not.toBe(0);
  });

  it("takes `user`'s answer through --end, and still demands a reason", () => {
    snap();
    const r = run({ task: 't1', unit: 'auth', branch: 'feat/auth-r3', end: 'abandoned' });
    expect(r.code).toBe(2);
    expect(r.message).toContain('--reason is required');
    assertUntouched();
    // --end short-circuits the lookup entirely: the answer is already `user`'s.
    expect(hostAsked).toBe(0);
  });

  it('stores the MR URL in the history entry', () => {
    const r = run({
      task: 't1',
      unit: 'auth',
      branch: 'feat/auth-r3',
      end: 'abandoned',
      reason: 'user asked to drop it; the ticket was descoped',
      at: '2026-08-26',
    });
    expect(r.code, r.message).toBe(0);

    const h = history('auth');
    expect(h).toHaveLength(2);
    expect(h[1].end).toBe('abandoned');
    expect(h[1].mr, 'it is awkward to look up once the branch is gone').toBe(MR);
    expect(unitField('auth', 'branch')).toBe('feat/auth-r3');
  });
});

describe('an unreachable host is also a question, not a guess', () => {
  it('exits 4 and changes nothing', () => {
    new Task('t1').unit('auth').set('mr', MR);
    snap();
    hostSays = 'unknown';

    const r = run({ task: 't1', unit: 'auth', branch: 'feat/auth-r4' });
    expect(r.code).toBe(4);
    expect(r.message).toContain('cannot tell how this round ended');
    assertUntouched();
  });
});

describe('merged means delivered', () => {
  it('starts the next round from target, which already contains the old one', () => {
    hostSays = 'merged';
    const r = run({ task: 't1', unit: 'auth', branch: 'feat/auth-r4', at: '2026-08-27' });
    expect(r.code, r.message).toBe(0);

    const h = history('auth');
    expect(h[2].end).toBe('delivered');
    expect(h[2].at).toBe('2026-08-27');
    expect(unitField('auth', 'branch')).toBe('feat/auth-r4');
    expect(fxGit(['-C', clone, 'rev-parse', 'feat/auth-r4']).stdout.trim()).toBe(
      fxGit(['-C', clone, 'rev-parse', 'origin/main']).stdout.trim(),
    );
    expect(readFileSync(join(home, 'tasks', 't1', 'log.md'), 'utf8')).toContain(
      'auth  delivered feat/auth-r3 → feat/auth-r4',
    );
  });

  it('never asks the host about a round whose conclusion is already written', () => {
    const h = history('auth');
    expect(h[0].end).toBe('abandoned');
    expect(h[1].end).toBe('abandoned');
  });
});

describe('closed means abandoned', () => {
  it('is decided by the host, not by the caller', () => {
    new Task('t1').unit('proto').set('mr', MR);
    hostSays = 'closed';
    const r = run({
      task: 't1',
      unit: 'proto',
      branch: 'feat/proto-r2',
      reason: 'the RFC was rejected upstream',
    });
    expect(r.code, r.message).toBe(0);
    expect(history('proto')[0].end).toBe('abandoned');
    expect(hostAsked).toBe(1);
  });
});

describe("the built-in default carries the NEXT round's number", () => {
  it('counts history AFTER this rotation appends to it', () => {
    // Off by one and the default would hand back the name of the branch being
    // replaced, which is precisely the collision the round number exists to
    // stop: the same branch name cannot be created twice.
    expect(history('proto')).toHaveLength(1);
    const r = run({
      task: 't1',
      unit: 'proto',
      branch: true,
      reason: 'starting the third round from scratch',
    });
    expect(r.code, r.message).toBe(0);
    expect(unitField('proto', 'branch'), 'r1 was yan/t1-proto-r1, r2 was feat/proto-r2').toBe('yan/t1-proto-r3');
    expect(history('proto')).toHaveLength(2);
    expect(history('proto')[1].branch).toBe('feat/proto-r2');
  });
});

describe('the three plain scalars, each of them a decision', () => {
  it('sets target, mode and scope, and refuses a mode outside the closed set', () => {
    expect(runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'proto', '--target', 'release/8']).code).toBe(0);
    expect(unitField('proto', 'target')).toBe('release/8');

    expect(runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'proto', '--mode', 'branch']).code).toBe(0);
    expect(unitField('proto', 'mode')).toBe('branch');

    expect(runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'proto', '--mode', 'sideways']).code).not.toBe(0);

    expect(runYan(home, ['unit', 'set', '--task', 't1', '--unit', 'proto', '--scope', 'libs/proto', '--scope', 'libs/shared']).code).toBe(0);
    expect(unitField('proto', 'scope')).toEqual(['libs/proto', 'libs/shared']);
  });
});

describe('the same branch twice is not a new round', () => {
  it('is refused, and moves nothing', () => {
    snap();
    const r = run({ task: 't1', unit: 'auth', branch: 'feat/auth-r4', end: 'delivered' });
    expect(r.code).toBe(2);
    expect(r.message).toContain('same as the current one');
    assertUntouched();
  });
});

describe('history is append-only, and the whole file is still valid', () => {
  it('has never rewritten history[0]', () => {
    expect(history('auth')).toHaveLength(3);
    expect(history('auth')[0].branch).toBe('yan/t1-auth-r1');
  });
});
