import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  mkTempDir,
  mkYanHome,
  registerRepo,
  runYan,
} from '../helpers/fixtures.js';
import { clockOut, type Closer, type DoneDeps, type DoneOptions } from '../../src/cli/shift.js';
import { Task } from '../../src/records/task/index.js';
import { WorktreeError, type LeaseRow, type ReturnExpectation } from '../../src/externals/worktree/index.js';
import type { MrState } from '../../src/externals/remote-git/index.js';

/**
 * `yan shift done`, and the order it has to keep: MR merged → outcome.md →
 * the log line → rm -rf run/ → return the tree → delete the remote branch.
 * Backwards, everything still looks like it worked until a squash-merged
 * shift strands a pool slot.
 *
 * Every step appends to one call log, so the order is an exact assertion, and
 * the pool stand-in records whether run/ still existed when the tree came
 * back. A `done` wake must never stand in for asking the host.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let tree = '';
let previousHome: string | undefined;
let calls: string[] = [];

const MR = 'https://forge.invalid/acme/widget/-/merge_requests/31';
const LEASE = 'lease-abc123';

let hostSays: MrState = 'merged';
let leases: LeaseRow[] = [];
let returnRefusal: Error | undefined;

class FakePool {
  public status(): LeaseRow[] {
    return leases;
  }

  public return(target: string, expect: ReturnExpectation = {}): string {
    const witness = existsSync(join(home, 'tasks', 't042', 'shifts', 's1', 'run')) ? 'present' : 'absent';
    calls.push(`pool_return path=${target} lease_id=${expect.leaseId ?? ''} holder=${expect.holder ?? ''} witness=${witness}`);
    if (returnRefusal !== undefined) throw returnRefusal;
    leases = leases.filter((l) => l.path !== target);
    return target;
  }
}

class FakeTerminal implements Closer {
  public close(pane: string): void {
    calls.push(`agent_close pane=${pane}`);
  }

  public clearPaneTitle(pane: string): void {
    calls.push(`title_clear pane=${pane}`);
  }
}

function deps(): DoneDeps {
  return {
    terminal: new FakeTerminal(),
    pool: () => new FakePool(),
    mrStateOf: (mr) => {
      calls.push(`mr_state mr=${mr}`);
      return hostSays;
    },
    deleteBranch: (c, b) => {
      calls.push(`git push origin --delete ${b}`);
      return true;
    },
  };
}

function run(sid: string, options: DoneOptions = {}): { code: number; message: string } {
  try {
    clockOut(sid, options, deps());
    return { code: 0, message: '' };
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { code: e.exitCode ?? 1, message: e.message ?? '' };
  }
}

/** Comments may name what is forbidden; code may not run it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** A dispatched shift, as `yan shift new` leaves one. */
function dispatched(sid: string, overrides: Record<string, unknown> = {}): string {
  const run_ = join(home, 'tasks', 't042', 'shifts', sid, 'run');
  mkdirSync(run_, { recursive: true });
  writeFileSync(
    join(run_, 'meta.json'),
    `${JSON.stringify({
      version: 1, task: 't042', sid, unit: 'auth', repo: 'monorepo-x',
      branch: `yan/t042-auth-${sid}`, base: 'feat/auth', tree, clone,
      holder: `t042/auth/${sid}`, lease_id: LEASE, agent: 'claude',
      container: 'w1', pane: 'w1:p7', mr: MR, ...overrides,
    })}\n`,
  );
  writeFileSync(join(run_, 'status'), '2026-08-09T09:00:00Z\tstarted\tread the brief\n');
  leases = [
    { slot: 1, path: tree, branch: `yan/t042-auth-${sid}`, base: 'feat/auth', holder: `t042/auth/${sid}`, lease_id: LEASE, at: 0 },
  ];
  return run_;
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  process.env.YAN_HOME = home;
  clone = join(home, 'repos', 'monorepo-x');
  mkdirSync(clone, { recursive: true });
  registerRepo(home, 'monorepo-x', clone);
  tree = join(tmp, 'tree1');
  mkdirSync(tree, { recursive: true });

  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'monorepo-x', 'master', { branch: 'feat/auth', scope: ['apps/auth'] });

  calls = [];
  hostSays = 'merged';
  returnRefusal = undefined;
  leases = [];
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('an unmerged merge request stops everything', () => {
  it('exits 4 and tears nothing down', () => {
    const runDir = dispatched('s1');
    hostSays = 'open';

    const r = run('s1');
    expect(r.code, 'a shift clocks out when its MR has merged, and nothing sooner').toBe(4);
    expect(r.message).toContain("is 'open', not merged");
    expect(existsSync(join(runDir, 'meta.json')), 'nothing is torn down before the host says merged').toBe(true);
    expect(calls.some((c) => c.startsWith('pool_return'))).toBe(false);
    expect(calls.some((c) => c.startsWith('git'))).toBe(false);
  });

  it('is what makes a `done` wake safe', () => {
    // A plan approval arrives as `done` too, and what follows "finished" is
    // destructive: `done` is a reason to look, never a verdict.
    const runDir = dispatched('s1');
    writeFileSync(join(runDir, 'status'), '2026-08-09T11:00:00Z\tdone\tI think I am finished\n');
    hostSays = 'open';

    const r = run('s1');
    expect(r.code).toBe(4);
    expect(existsSync(runDir), 'a done wake must not tear down a shift whose MR has not merged').toBe(true);
    expect(leases, 'and the tree is still leased').toHaveLength(1);
  });
});

describe('merged: the whole teardown, in order', () => {
  let runDir = '';

  beforeEach(() => {
    runDir = dispatched('s1');
    expect(run('s1').code).toBe(0);
  });

  it('asks the host, returns the tree, and only THEN deletes the branch', () => {
    expect(calls.map((c) => c.split(' ')[0])).toEqual([
      'mr_state',
      'pool_return',
      'git',
      'title_clear',
      'agent_close',
    ]);
  });

  it('deletes run/ before the tree is returned', () => {
    expect(calls.find((c) => c.startsWith('pool_return'))).toContain('witness=absent');
  });

  it('returns the tree under the identity it was taken with', () => {
    const line = calls.find((c) => c.startsWith('pool_return')) ?? '';
    expect(line, 'which is what makes a retry safe').toContain(`lease_id=${LEASE}`);
    expect(line).toContain('holder=t042/auth/s1');
  });

  it('deletes exactly the shift branch, on origin', () => {
    expect(calls).toContain('git push origin --delete yan/t042-auth-s1');
  });

  it('never asks git about ancestry', () => {
    // Ancestry would answer "not merged" about a squash merge. Comments may
    // name what is forbidden; code may not run it.
    const source = stripComments(readFileSync(join(process.cwd(), 'src', 'cli', 'shift.ts'), 'utf8'));
    for (const forbidden of ['merge-base', 'rev-list', '--contains']) {
      expect(source, forbidden).not.toContain(forbidden);
    }
    expect(calls).toContain(`mr_state mr=${MR}`);
  });

  it('leaves the long-lived files and removes only run/', () => {
    expect(existsSync(runDir), 'run/ is deleted whole - one directory, not a list of files').toBe(false);
    const outcome = join(home, 'tasks', 't042', 'shifts', 's1', 'outcome.md');
    expect(existsSync(outcome), 'outcome.md is long-lived and survives').toBe(true);
    expect(readFileSync(outcome, 'utf8')).toContain(MR);
    expect(readFileSync(join(home, 'tasks', 't042', 'log.md'), 'utf8')).toContain('merged into the integration branch');
    expect(leases, 'the pool slot is free again').toEqual([]);
  });

  it('refuses to clock the same shift out twice', () => {
    const again = run('s1');
    expect(again.code).toBe(2);
    expect(again.message).toContain('already clocked out');
  });
});

describe('a failed return stops before the branch is deleted', () => {
  it('is the last line of defence, so nothing after it runs', () => {
    // A tree that will not come back may hold the only copy of the work, so
    // the remote branch stays.
    dispatched('s2', { lease_id: 'not-the-one' });
    returnRefusal = WorktreeError.mismatch('the lease id does not match');

    const r = run('s2');
    expect(r.code, "a lease identity that does not match is refused with the pool's own code").toBe(3);
    expect(r.message).toContain('has NOT been deleted');
    expect(calls.some((c) => c.startsWith('git')), 'the branch survives a refused return').toBe(false);
  });
});

describe("the MR url reaches yan through the shift's own report", () => {
  it('is the only channel carrying the address back', () => {
    // The shift opens its own MR, so its `done` note is the only record of the
    // address. Whether it merged is still the host's answer.
    const reported = 'https://example.test/org/repo/pull/42';
    const runDir = dispatched('s1', { mr: '' });
    writeFileSync(
      join(runDir, 'status'),
      `2026-08-09T09:00:00Z\tstarted\tread the brief\n2026-08-09T09:30:00Z\tdone\tmr ${reported}\n`,
    );

    expect(run('s1').code).toBe(0);
    expect(calls, 'the URL the shift reported is the one the host is asked about').toContain(
      `mr_state mr=${reported}`,
    );
    expect(readFileSync(join(home, 'tasks', 't042', 'shifts', 's1', 'outcome.md'), 'utf8')).toContain(reported);
  });
});

describe('a teardown that stopped at the tree return can be finished', () => {
  it('derives which shift it was from the pool, not from a stored flag', () => {
    // run/ gone with the tree still leased looks identical to a clean
    // clock-out from disk; the pool's holder is what tells them apart.
    mkdirSync(join(home, 'tasks', 't042', 'shifts', 's3'), { recursive: true });
    writeFileSync(join(home, 'tasks', 't042', 'shifts', 's3', 'outcome.md'), `# s3\n- merge request: ${MR} (merged)\n`);
    leases = [
      { slot: 1, path: tree, branch: 'yan/t042-auth-s3', base: 'feat/auth', holder: 't042/auth/s3', lease_id: LEASE, at: 0 },
    ];

    const r = run('s3');
    expect(r.code, r.message).toBe(0);
    // The host is not asked again: that step already ran in the attempt that
    // stopped, and its answer went with run/.
    expect(calls.some((c) => c.startsWith('mr_state'))).toBe(false);
    expect(calls.some((c) => c.startsWith('pool_return'))).toBe(true);
    expect(calls).toContain('git push origin --delete yan/t042-auth-s3');
  });

  it('says a shift really has clocked out when the pool holds nothing for it', () => {
    mkdirSync(join(home, 'tasks', 't042', 'shifts', 's4'), { recursive: true });
    leases = [];
    const r = run('s4');
    expect(r.code).toBe(2);
    expect(r.message).toContain('already clocked out');
  });
});

describe('usage', () => {
  it('needs a shift id, and is reachable as `yan shift done`', async () => {
    expect(run('').code).toBe(2);
    const r = await runYan(home, ['shift', 'done', '--task', 't042']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('a shift id is required');
  });
});
