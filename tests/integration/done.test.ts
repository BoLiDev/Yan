import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  mkTempDir,
  mkYanHome,
  registerRepo,
  runYan,
} from '../helpers/fixtures.js';
import { finishTask, type Closer, type DoneDeps, type DoneOptions } from '../../src/cli/done.js';
import { Task } from '../../src/records/task/index.js';
import { WorktreeError, type LeaseRow, type ReturnOptions } from '../../src/externals/worktree/index.js';

/**
 * `yan done` — the command that finishes a task.
 *
 * Two properties are what this file exists for, and both of them fail quietly
 * if they regress:
 *
 *   1. The default destroys nothing. A live shift stops the command before any
 *      tree is touched and before `complete` is set; a tree the pool's
 *      orphan-commit guard will not take back leaves the task open.
 *   2. `--force` is `user`'s answer, not a retry. It is the only thing in yan
 *      that reaches past that guard (boundaries.md §9.2), so nothing else may
 *      grow a way to do it — `yan tree return` in particular must stay flagless.
 *
 * The pool is a stand-in here so the order and the authority can be asserted
 * exactly. That force really does wipe a dirty tree, and really does leave the
 * commits alone, is proved against real git in
 * `src/externals/worktree/worktree.test.ts`.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let tree = '';
let previousHome: string | undefined;
let previousTask: string | undefined;
let calls: string[] = [];

const LEASE = 'lease-abc123';

let leases: LeaseRow[] = [];
let returnRefusal: Error | undefined;

class FakePool {
  public status(): LeaseRow[] {
    return leases;
  }

  public return(target: string, options: ReturnOptions = {}): string {
    calls.push(
      `pool_return path=${target} lease_id=${options.leaseId ?? ''} holder=${options.holder ?? ''} force=${options.force === true}`,
    );
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
  return { terminal: new FakeTerminal(), pool: () => new FakePool() };
}

function run(options: DoneOptions = {}): { code: number; message: string } {
  try {
    finishTask({ task: 't042', ...options }, deps());
    return { code: 0, message: '' };
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { code: e.exitCode ?? 1, message: e.message ?? '' };
  }
}

const complete = (): boolean => new Task('t042').isComplete();

/** A dispatched shift holding a tree, as `yan shift new` leaves one. */
function dispatched(sid: string): string {
  const run_ = join(home, 'tasks', 't042', 'shifts', sid, 'run');
  mkdirSync(run_, { recursive: true });
  writeFileSync(
    join(run_, 'meta.json'),
    `${JSON.stringify({
      version: 1, task: 't042', sid, unit: 'auth', repo: 'monorepo-x',
      branch: `yan/t042-auth-${sid}`, base: 'feat/auth', tree, clone,
      holder: `t042/auth/${sid}`, lease_id: LEASE, agent: 'claude',
      container: 'w1', pane: 'w1:p7',
    })}\n`,
  );
  writeFileSync(join(run_, 'status'), '2026-08-09T09:00:00Z\tstarted\tread the brief\n');
  held(sid);
  return run_;
}

/** The pool holding one tree for this task, with no shift record at all. */
function held(sid: string): void {
  leases = [
    { slot: 1, path: tree, branch: `yan/t042-auth-${sid}`, base: 'feat/auth', holder: `t042/auth/${sid}`, lease_id: LEASE, at: 0 },
  ];
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  previousTask = process.env.YAN_TASK;
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  process.env.YAN_HOME = home;
  delete process.env.YAN_TASK;
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
  leases = [];
  returnRefusal = undefined;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
  if (previousTask === undefined) delete process.env.YAN_TASK;
  else process.env.YAN_TASK = previousTask;
});

describe('the ordinary case', () => {
  it('marks the task done and gives its tree back', () => {
    held('s1');
    const r = run();
    expect(r.code, r.message).toBe(0);
    expect(complete()).toBe(true);
    expect(calls).toEqual([`pool_return path=${tree} lease_id=${LEASE} holder=t042/auth/s1 force=false`]);
    expect(leases, 'the pool slot is free again').toEqual([]);
    expect(readFileSync(join(home, 'tasks', 't042', 'log.md'), 'utf8')).toContain('task marked done');
  });

  it('finishes a task that never leased anything', () => {
    expect(run().code).toBe(0);
    expect(complete()).toBe(true);
    expect(calls).toEqual([]);
  });

  it('is idempotent: a task already done can be run again', () => {
    new Task('t042').setComplete(true);
    held('s1');
    expect(run().code).toBe(0);
    expect(complete()).toBe(true);
    expect(calls, 'and a tree left behind is still collected').toHaveLength(1);
  });

  it('finds a tree left behind by a teardown that stopped halfway', () => {
    // run/ is gone and the tree is still leased. The holder the pool records
    // is <task>/<unit>/<sid>, which is why nothing had to be stored for this.
    held('s7');
    expect(run().code).toBe(0);
    expect(calls[0]).toContain('holder=t042/auth/s7');
  });
});

describe('a live shift stops everything, and nothing is touched', () => {
  it('exits 4, leaves the tree leased and the task open', () => {
    const runDir = dispatched('s1');

    const r = run();
    expect(r.code, 'a shift may be mid-edit; its tree is not yan\'s to take').toBe(4);
    expect(r.message).toContain('still has live shifts: s1 (auth)');
    expect(r.message).toContain('--force');
    expect(existsSync(join(runDir, 'meta.json')), 'nothing is torn down').toBe(true);
    expect(complete(), 'and the task stays open').toBe(false);
    expect(calls, 'no tree was even looked at').toEqual([]);
    expect(leases).toHaveLength(1);
  });
});

describe('--force is user\'s answer, and it is the whole authority', () => {
  it('kills the live shift, wipes past the guard, and marks the task done', () => {
    const runDir = dispatched('s1');

    const r = run({ force: true });
    expect(r.code, r.message).toBe(0);
    expect(calls).toEqual([
      'title_clear pane=w1:p7',
      'agent_close pane=w1:p7',
      `pool_return path=${tree} lease_id=${LEASE} holder=t042/auth/s1 force=true`,
    ]);
    expect(existsSync(runDir), 'run/ is removed whole').toBe(false);
    expect(complete()).toBe(true);
    expect(readFileSync(join(home, 'tasks', 't042', 'log.md'), 'utf8')).toContain('--force: killed s1');
  });

  it('keeps the long-lived files of a shift it killed', () => {
    // What a killed shift reported before it was killed is often the reason it
    // was, so outcome.md and the brief survive. Only run/ is throwaway.
    dispatched('s1');
    const dir = join(home, 'tasks', 't042', 'shifts', 's1');
    writeFileSync(join(dir, 'outcome.md'), '# s1\nI got stuck.\n');

    expect(run({ force: true }).code).toBe(0);
    expect(existsSync(join(dir, 'outcome.md'))).toBe(true);
  });

  it('is the only place in yan that forces a return', () => {
    // The one line of boundaries.md §9.2 this file holds. If a second command
    // learns to force a tree back, `user` has stopped being the one who
    // decides — and it is the kind of edit nothing else would notice. Comments
    // may name what is forbidden; code may not run it.
    const forcing: string[] = [];
    for (const file of readdirSync(join(process.cwd(), 'src', 'cli'))) {
      if (!file.endsWith('.ts') || file === 'done.ts') continue;
      const source = readFileSync(join(process.cwd(), 'src', 'cli', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      if (/\.return\s*\([^)]*\bforce\b/s.test(source)) forcing.push(file);
    }
    expect(forcing, 'only yan done may pass force to the pool').toEqual([]);
  });
});

describe('a tree that will not come back', () => {
  it('exits 5 and leaves the task OPEN, because the work exists in one place', () => {
    held('s1');
    returnRefusal = new WorktreeError('failed', 'refusing to return: it has uncommitted changes');

    const r = run();
    expect(r.code).toBe(5);
    expect(r.message).toContain('is NOT marked done');
    expect(r.message).toContain('uncommitted changes');
    expect(complete()).toBe(false);
  });

  it('under --force, says the task IS done and the slot is stranded', () => {
    // Both halves are true and both have to be said: `user` asked for the task
    // to be finished, and a slot that will not release is a separate problem
    // they now have to know about.
    held('s1');
    returnRefusal = new WorktreeError('failed', 'cannot reset the tree');

    const r = run({ force: true });
    expect(r.code).toBe(5);
    expect(r.message).toContain('stranded');
    expect(complete()).toBe(true);
  });
});

describe('through bin/yan, the way a person and an agent reach it', () => {
  const yan = (args: readonly string[], env: Record<string, string | undefined> = {}) =>
    runYan(home, args, env);

  it('takes the task as an argument, as --task, or from $YAN_TASK', async () => {
    expect((await yan(['done', 't042'])).code).toBe(0);
    expect(new Task('t042').isComplete()).toBe(true);
    expect((await yan(['done', '--task', 't042'])).code).toBe(0);
    expect((await yan(['done'], { YAN_TASK: 't042' })).code).toBe(0);
  });

  it('refuses without a terminal rather than hanging on a prompt it cannot show', async () => {
    // The half of the soft/hard rule that matters (cli-ux.md §1): an agent, a
    // hook or a script that reached the multi-select would wait forever.
    const none = await yan(['done'], { YAN_TASK: undefined });
    expect(none.code).toBe(2);
    expect(none.out).toContain('which task?');
  });

  it('refuses an unknown task and two different names', async () => {

    const nope = await yan(['done', 'nosuch']);
    expect(nope.code).not.toBe(0);
    expect(nope.out).toContain('no such task');

    const two = await yan(['done', 't042', '--task', 't999']);
    expect(two.code).toBe(2);
    expect(two.out).toContain('two different tasks named');
  });

  it('offers exactly the tasks that are still open, and drops them as they finish', async () => {
    // The rows of the multi-select. They are `yan ls`'s own scan, so there is
    // one owner for "which tasks are there" and the prompt cannot offer
    // something the queue does not show. Clack itself is not driven here — the
    // choices are, which is where the logic is.
    const { finishableTasks } = await import('../../src/cli/done.js');
    Task.create('t043', 'the second one');

    expect(finishableTasks().map((t) => t.id)).toEqual(['t042', 't043']);
    expect(finishableTasks()[0]).toMatchObject({ title: 'unify the auth header', units: 1, shifts: 0 });

    expect((await yan(['done', 't042'])).code).toBe(0);
    expect(finishableTasks().map((t) => t.id), 'a finished task is no longer on offer').toEqual(['t043']);

    expect((await yan(['done', 't043'])).code).toBe(0);
    expect(finishableTasks()).toEqual([]);
  });

  it('turns the queue entry from open to done, which nothing could do before', async () => {
    expect((await yan(['ls'])).stdout).toMatch(/t042\s+open/);
    expect((await yan(['done', 't042'])).code).toBe(0);
    expect((await yan(['ls'])).stdout).toMatch(/t042\s+done/);
  });

  it('prints one envelope with --json, whether it finished one task or several', async () => {
    const r = await yan(['done', 't042', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const json = JSON.parse(r.stdout) as { version: number; tasks: Record<string, unknown>[] };
    expect(json.version).toBe(1);
    expect(json.tasks).toHaveLength(1);
    expect(json.tasks[0]).toMatchObject({ task: 't042', complete: true, forced: false });
  });

  it('leaves `yan tree return` with no way past the guard', async () => {
    // The user-facing half of the authority: the pool can be forced, but only
    // through the command that carries `user`'s answer.
    const r = await yan(['tree', 'return', '--repo', 'monorepo-x', '--path', tree, '--force']);
    expect(r.code, 'there is no --force on tree return').toBe(2);
    expect(r.out).toContain('unknown option');
  });
});
