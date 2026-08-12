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
import { dispatch, type Deps, type Dispatcher, type NewOptions } from '../../src/cli/shift.js';
import { Task } from '../../src/records/task/index.js';
import { WorktreeError, type LeaseGrant, type ReturnExpectation } from '../../src/externals/worktree/index.js';

/**
 * `yan shift new`.
 *
 * What is under test: "`shift new` asserts the sub-agent's cwd is not a main clone
 * and refuses otherwise" — one of the four mvp ordering regressions, and the
 * one whose failure hides completely: everything looks like it worked. So the
 * pool is programmed to hand out the main clone and this command has to refuse,
 * not warn, and give the tree back on its way out.
 *
 * And A further sixth: "a `shift new` that fails after leasing returns the
 * tree." Every failure after step 2 is checked for that, not only the assertion.
 *
 * The order is checked, not assumed: every step appends to one call log, so
 * "the brief did not exist yet when the tree was leased" and "it did by the
 * time the agent started" are exact assertions.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let tree = '';
let previousHome: string | undefined;
let calls: string[] = [];

/** What the pool hands out, and what it was holding when. */
class FakePool {
  public path = '';
  public full = false;
  public lease = 'lease-abc123';

  public get(size: number, base: string, branch: string, holder: string): LeaseGrant {
    calls.push(`pool_get base=${base} branch=${branch} holder=${holder} brief=${briefState()}`);
    if (this.full) throw new WorktreeError('full', 'the pool is full');
    return { path: this.path, lease_id: this.lease, holder };
  }

  public return(target: string, expect: ReturnExpectation = {}): string {
    calls.push(`pool_return path=${target} lease_id=${expect.leaseId ?? ''}`);
    return target;
  }
}

class FakeTerminal implements Dispatcher {
  public startArgs: string[] = [];
  public startEnv: Record<string, string> = {};
  public cwd = '';
  public titles: string[] = [];
  public titleThrows = false;

  public createContainer(label: string): { workspace: string } {
    calls.push(`container_create name=${label}`);
    return { workspace: 'w1' };
  }

  public startAgent(options: {
    container: string;
    name: string;
    kind: string;
    cwd: string;
    env?: Record<string, string>;
    argv?: readonly string[];
  }): { pane: string } {
    calls.push(
      `agent_start container=${options.container} name=${options.name} kind=${options.kind} cwd=${options.cwd} brief=${briefState()}`,
    );
    this.startArgs = [...(options.argv ?? [])];
    this.startEnv = { ...(options.env ?? {}) };
    this.cwd = options.cwd;
    return { pane: 'w1:p2' };
  }

  public setPaneTitle(pane: string, title: string): void {
    if (this.titleThrows) throw new Error('herdr refused the title');
    this.titles.push(`${pane}=${title}`);
  }
}

let pool: FakePool;
let terminal: FakeTerminal;

function briefState(): string {
  return existsSync(join(home, 'tasks', 't042', 'shifts', 's1', 'brief.md')) ? 'present' : 'absent';
}

function deps(): Deps {
  return {
    terminal,
    pool: () => pool,
  };
}

function run(options: NewOptions): { code: number; message: string; meta: Record<string, unknown> } {
  try {
    return { code: 0, message: '', meta: dispatch(options, deps()) };
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { code: e.exitCode ?? 1, message: e.message ?? '', meta: {} };
  }
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  process.env.YAN_HOME = home;

  clone = join(home, 'repos', 'monorepo-x');
  mkdirSync(clone, { recursive: true });
  // A clone is where the registry says it is now, not where a convention put
  // it. The path does not change; only the reason yan
  // can find it.
  registerRepo(home, 'monorepo-x', clone);
  tree = join(tmp, 'tree1');
  mkdirSync(join(tree, 'apps', 'auth'), { recursive: true });
  mkdirSync(join(tree, 'apps', 'common'), { recursive: true });

  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'monorepo-x', 'master', {
    branch: 'feat/auth',
    scope: ['apps/auth', 'apps/common'],
  });

  calls = [];
  pool = new FakePool();
  pool.path = tree;
  terminal = new FakeTerminal();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('the order', () => {
  it('leases, then makes the container, then starts the agent', () => {
    const r = run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'parse the header' });
    expect(r.code, r.message).toBe(0);
    // No sync. Running one first would mean the shift branch came off a head
    // that had just caught up with target — but a shift's MR goes into the
    // integration branch, and target only matters at the outbound MR. The sync
    // was buying a property nothing downstream needed and charging a fetch, a
    // merge, a push and a leased tree for it on every dispatch.
    expect(calls.map((c) => c.split(' ')[0])).toEqual([
      'pool_get',
      'container_create',
      'agent_start',
    ]);
  });

  it('writes the brief AFTER the tree is leased and BEFORE the agent starts', () => {
    run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'parse the header' });
    expect(calls.find((c) => c.startsWith('pool_get'))).toContain('brief=absent');
    expect(calls.find((c) => c.startsWith('agent_start'))).toContain('brief=present');
  });

  it('cuts the shift branch from the integration branch, and names it ours', () => {
    run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'x' });
    const get = calls.find((c) => c.startsWith('pool_get')) ?? '';
    expect(get).toContain('base=feat/auth');
    expect(get, 'the shift branch is always yan/<task>-<unit>-<sid>').toContain('branch=yan/t042-auth-s1');
    expect(get, 'the holder is <task>/<unit>/<sid>').toContain('holder=t042/auth/s1');
    // git itself forbids feat/auth and feat/auth/s1 coexisting.
    expect(get, 'never derived from the integration branch').not.toContain('branch=feat/auth/');
  });
});

describe('what the agent was started with', () => {
  beforeEach(() => {
    run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'parse the header' });
  });

  it('starts in the main scope path inside the tree, never the main clone', () => {
    expect(terminal.cwd.replace(/\\/g, '/')).toBe(join(tree, 'apps', 'auth').replace(/\\/g, '/'));
    expect(terminal.cwd).not.toBe(clone);
  });

  it('points YAN_TASK_DIR outside the worktree, which a tree return would wipe', () => {
    expect(terminal.startEnv.YAN_TASK_DIR).toBe(new Task('t042').dir);
    expect(terminal.startEnv.YAN_SHIFT_DIR).toContain('shifts/s1');
    expect(terminal.startEnv.YAN_SID).toBe('s1');
    expect(terminal.startEnv.YAN_HOME).toBeTruthy();
  });

  it('adds the rest of scope with the harness flag, from a small table', () => {
    expect(terminal.startArgs.join(' ')).toContain(`--add-dir ${join(tree, 'apps', 'common').replace(/\\/g, '/')}`);
  });

  it('lets the shift run unattended, because nobody is watching the pane', () => {
    // Without this the agent stops on its first tool call waiting for someone to
    // answer "Do you want to proceed?" - observed against a real dispatch.
    expect(terminal.startArgs).toContain('--dangerously-skip-permissions');
  });

  it('points the opening prompt at the brief', () => {
    expect(terminal.startArgs[terminal.startArgs.length - 1]).toContain('brief.md');
  });
});

describe('codex, and the gate yan cannot survive', () => {
  // Two first-run gates were measured here. Herdr calls the trust dialog
  // `blocked`, so supervision escalates and somebody answers it. It matches no
  // rule at all against the hook-review prompt and calls it `idle`, so a shift
  // parks on that one in an unfocused pane and nothing ever wakes.
  //
  // `user` decided to pass the flag that clears it, knowing the cost: hooks
  // shipped by the target repository then run without review. These assertions
  // exist so that decision is reversed on purpose rather than by accident —
  // and it should be reversed the moment Herdr's manifest learns the prompt,
  // which is one word (`esc to go back`, not `esc to cancel`).
  it('never parks silently on hook review, in either mode', () => {
    new Task('t042').addUnit('api', 'monorepo-x', 'master', {
      branch: 'feat/api',
      mode: 'mr',
      scope: ['apps/auth'],
    });
    run({ task: 't042', unit: 'api', sid: 's80', briefText: 'go', agent: 'codex' });
    expect(terminal.startArgs).toContain('--dangerously-bypass-hook-trust');
    expect(terminal.startArgs).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('and a scout gets it too, because a scout is just as unattended', () => {
    new Task('t042').addUnit('look', 'monorepo-x', 'master', {
      branch: 'feat/look',
      mode: 'scout',
      scope: ['apps/auth'],
    });
    run({ task: 't042', unit: 'look', sid: 's81', briefText: 'just look', agent: 'codex' });
    expect(terminal.startArgs).toContain('--dangerously-bypass-hook-trust');
    // What keeps a scout honest is containment, not a prompt.
    expect(terminal.startArgs).toContain('--sandbox');
    expect(terminal.startArgs).toContain('read-only');
    expect(terminal.startArgs, 'a scout must never be given a free hand').not.toContain(
      '--dangerously-bypass-approvals-and-sandbox',
    );
  });
});

describe('a scout is the exception', () => {
  it('keeps plan mode and is never given a free hand', () => {
    new Task('t042').addUnit('probe', 'monorepo-x', 'master', {
      branch: 'feat/probe',
      mode: 'scout',
      scope: ['apps/auth'],
    });
    run({ task: 't042', unit: 'probe', sid: 's90', briefText: 'just look' });
    expect(terminal.startArgs).toContain('--permission-mode');
    expect(terminal.startArgs).toContain('plan');
    expect(terminal.startArgs, 'a scout must never be given a free hand').not.toContain(
      '--dangerously-skip-permissions',
    );
  });
});

describe('the brief', () => {
  it('says which tree, which branch, and where artifacts go', () => {
    run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'parse the header' });
    const body = readFileSync(join(home, 'tasks', 't042', 'shifts', 's1', 'brief.md'), 'utf8');
    expect(body).toContain('parse the header');
    expect(body).toContain(tree);
    expect(body).toContain('yan/t042-auth-s1');
    expect(body, 'artifacts go outside the worktree').toContain(`${new Task('t042').dir}/artifacts`);
    expect(body).toContain('yan report');
  });
});

describe('run/meta.json', () => {
  it('records what every later reader needs, and no CR anywhere', () => {
    run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'x' });
    const file = join(home, 'tasks', 't042', 'shifts', 's1', 'run', 'meta.json');
    const raw = readFileSync(file, 'utf8');
    expect(raw, 'meta.json is LF only').not.toContain('\r');

    const meta = JSON.parse(raw) as Record<string, unknown>;
    expect(meta.version).toBe(1);
    expect(meta.unit).toBe('auth');
    expect(meta.branch).toBe('yan/t042-auth-s1');
    expect(meta.tree).toBe(tree);
    expect(meta.agent).toBe('claude');
    expect(meta.lease_id, 'the lease id is what makes the return safe on a retry').toBe('lease-abc123');
    expect(meta.holder).toBe('t042/auth/s1');
    expect(meta.container).toBe('w1');
    expect(meta.pane, 'terminal ids, never labels').toBe('w1:p2');
    expect(meta.base).toBe('feat/auth');
    expect(meta.clone).toBe(clone.replace(/\\/g, '/'));
  });
});

describe('display metadata', () => {
  it('titles the pane at dispatch', () => {
    run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'x' });
    expect(terminal.titles).toEqual(['w1:p2=s1-auth · unit=auth']);
  });

  it('is never fatal: a refused title costs a line, not the dispatch', () => {
    terminal.titleThrows = true;
    const r = run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'x' });
    expect(r.code, r.message).toBe(0);
    expect(existsSync(join(home, 'tasks', 't042', 'shifts', 's1', 'run', 'meta.json'))).toBe(true);
  });
});

describe('sid is derived, and it increases', () => {
  it('scans shifts/ and carries no round number', () => {
    run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'first' });
    calls = [];
    const r = run({ task: 't042', unit: 'auth', briefText: 'second one' });
    expect(r.code, r.message).toBe(0);
    expect(existsSync(join(home, 'tasks', 't042', 'shifts', 's2', 'brief.md'))).toBe(true);
    expect(calls.find((c) => c.startsWith('pool_get'))).toContain('branch=yan/t042-auth-s2');
  });

  it('refuses a sid that already exists', () => {
    run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'first' });
    const again = run({ task: 't042', unit: 'auth', sid: 's1' });
    expect(again.code).toBe(2);
    expect(again.message).toContain('already exists');
  });
});

describe('THE ASSERTION: the working directory is never the main clone', () => {
  it('refuses when the pool hands out the main clone itself', () => {
    pool.path = clone;
    pool.lease = 'lease-danger';
    mkdirSync(join(clone, 'apps', 'auth'), { recursive: true });

    const r = run({ task: 't042', unit: 'auth', sid: 's9', briefText: 'must not run' });
    expect(r.code, 'starting a shift in the main clone is refused, not warned about').toBe(4);
    expect(r.message).toContain('main clone');
    expect(r.message).toContain('refusing to start');

    expect(calls.some((c) => c.startsWith('agent_start')), 'no agent may be started after the refusal').toBe(false);
    const ret = calls.find((c) => c.startsWith('pool_return'));
    expect(ret, 'and the tree goes straight back').toBeDefined();
    expect(ret, 'returned under the identity it was leased with').toContain('lease_id=lease-danger');
    expect(existsSync(join(home, 'tasks', 't042', 'shifts', 's9')), 'a refused dispatch leaves nothing behind').toBe(false);
  });

  it('refuses a working directory INSIDE the main clone, which only a prefix test catches', () => {
    // The tree path itself is not equal to the clone here.
    pool.path = join(clone, 'nested');
    mkdirSync(join(clone, 'nested', 'apps', 'auth'), { recursive: true });

    const r = run({ task: 't042', unit: 'auth', sid: 's9', briefText: 'must not run' });
    expect(r.code).toBe(4);
    expect(calls.some((c) => c.startsWith('agent_start'))).toBe(false);
  });
});

describe('a shift new that fails after leasing returns the tree', () => {
  it('does so on every failing path, not only the assertion', () => {
    // A further regression 6: the tree is already
    // leased, and a dispatch that throws after step 2 must return it or the
    // pool leaks a slot on every failed attempt.
    terminal.startAgent = () => {
      throw new Error('herdr could not confirm the agent');
    };
    const r = run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'x' });
    expect(r.code).not.toBe(0);
    expect(calls.some((c) => c.startsWith('pool_return'))).toBe(true);
    expect(existsSync(join(home, 'tasks', 't042', 'shifts', 's1'))).toBe(false);
  });
});

describe('the pool being full is said as what it is', () => {
  it('has its own exit code and its own sentence', () => {
    pool.full = true;
    const r = run({ task: 't042', unit: 'auth', sid: 's9' });
    expect(r.code, 'a full pool has its own exit code').toBe(3);
    expect(r.message).toContain('pool is full');
    expect(r.message).toContain('cannot start a new shift');
  });
});

describe('dispatching does not touch target', () => {
  it('never syncs, so a branch behind target still dispatches', () => {
    const r = run({ task: 't042', unit: 'auth', sid: 's1', briefText: 'x' });
    expect(r.code, r.message).toBe(0);
    expect(calls.some((c) => c.startsWith('sync')), 'catching up with target is not a toll on dispatching').toBe(false);
    // And the branch it cut from is the integration branch as it stands, which
    // is the thing the shift's own merge request will go back into.
    expect(calls.find((c) => c.startsWith('pool_get'))).toContain('base=feat/auth');
  });
});

describe('usage', () => {
  it('names what is missing', () => {
    expect(run({ unit: 'auth' }).message).toContain('--task is required');
    expect(run({ task: 't042' }).message).toContain('--unit is required');
    const r = run({ task: 't042', unit: 'nosuch' });
    expect(r.code).toBe(2);
    expect(r.message).toContain('no such unit');
  });

  it('is reachable as `yan shift new` through the dispatcher', async () => {
    writeFileSync(join(home, 'config.json'), readFileSync(join(home, 'config.json'), 'utf8'));
    const r = await runYan(home, ['shift', 'new', '--task', 't042']);
    expect(r.out).toContain('--unit is required');
  });
});
