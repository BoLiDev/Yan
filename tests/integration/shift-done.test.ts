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
 * `yan shift done`, ported from `tests/unit/yan-shift-done-order.test.sh` and
 * `tests/integration/yan-shift-done-squash.test.sh`.
 *
 * Phase 7 Trace: "`shift done` order: MR merged → `outcome` → `rm -rf run/` →
 * return the tree → then delete the remote branch." It is the kind of
 * regression that never fails loudly: get it backwards and everything still
 * looks like it worked, right up until a squash-merged shift strands a pool
 * slot.
 *
 * Every step appends to one call log, so the order is an exact assertion. The
 * step no module can see — `run/` being deleted — is read off the pool's
 * witness: the stand-in records whether run/ still existed when the tree came
 * back.
 *
 * And Phase 7's own fifth regression: a `done` wake never tears down a shift
 * whose MR has not merged (orchestration.md §4). Plan approval arrives as
 * `done`, so a shift parked on one looks exactly like a shift that finished.
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
  // A clone is where the registry says it is now, not where a convention put
  // it (v3 td repos.md §2). The path does not change; only the reason yan
  // can find it.
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
    // orchestration.md §4: plan approval arrives as `done`, so a shift parked
    // on one looks exactly like a shift that finished — and what follows
    // "finished" is destructive. `done` is a reason to look, never a verdict.
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
    // A squash-merged branch is not an ancestor of the branch it landed on, so
    // ancestry would answer "not merged" about work that landed an hour ago.
    // Comments may name what is forbidden; code may not run it.
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
    // The moment the pool will not take a tree back is the moment the work may
    // exist nowhere else, and deleting the remote branch next would make that
    // permanent.
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
    // delivery.md §8.2 makes `done: mr <url>` the deliverable in mr mode. The
    // shift opens its own merge request, so nothing else records the address.
    // The host still decides whether it merged; the note only supplies what to
    // ask about.
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
    // run/ is gone and the tree is still leased: from $YAN_HOME that is
    // identical to a clean clock-out, and refusing would make the stranded slot
    // permanent. The pool records the holder as <task>/<unit>/<sid>, which is
    // everything steps 5 and 6 need.
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
