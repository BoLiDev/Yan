import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, repoRoot, runYan } from '../helpers/fixtures.js';

/**
 * `yan continue`, ported from `tests/unit/yan-continue.test.sh`.
 *
 * Two of its assertions carry over unchanged and are the easiest in the command
 * to lose in a rewrite (cli-ux.md §3):
 *
 *   A SECOND YAN ON THE SAME TASK IS REFUSED, and the lock is per TASK, not per
 *   home — two yans on two different tasks is ordinary working practice.
 *   WHEN ONE IS ALREADY ALIVE, `continue` SAYS WHERE IT IS rather than spawning
 *   a duplicate.
 *
 * And two are new, because V2's entry is: the main agent starts in the calling
 * pane, no container is created, and the workspace tokens this command set are
 * withdrawn when the agent exits (display.md §4, last row).
 *
 * The main agent is `process.execPath` — a real spawn of a real executable that
 * reads an empty stdin and exits 0. Nothing here needs a harness installed, and
 * "the agent really ran" stays an observation rather than a stub's opinion.
 */

afterAll(cleanupTempDirs);

let home = '';

const config = `${JSON.stringify(
  {
    version: 1,
    agents: { yan: process.execPath, shift: process.execPath },
    remote_git: { kind: 'github' },
  },
  null,
  2,
)}\n`;

/**
 * Every run pretends yan is NOT inside a Herdr pane.
 *
 * `HERDR_PANE_ID` is how this command finds the pane it is in, and the test
 * runner really is inside one — so without this the suite would relabel the
 * workspace of whoever is running it. The pane-aware half is exercised below
 * with an injected terminal instead, where the ids are the test's own.
 */
function yan(args: readonly string[], env: Record<string, string> = {}) {
  return runYan(home, args, { HERDR_PANE_ID: '', ...env });
}

function lockOf(task: string): string {
  return join(home, 'tasks', task, '.enter.lock');
}

/** A lock held by a process that really is alive: this one. */
function liveLock(task: string, identity: string): void {
  mkdirSync(join(home, 'tasks', task), { recursive: true });
  writeFileSync(
    lockOf(task),
    `${JSON.stringify({ pid: process.pid, host: hostname(), at: 1, identity })}\n`,
  );
}

beforeAll(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true, config });
  mkdirSync(join(home, 'repos', 'monorepo-x'), { recursive: true });
  mkdirSync(join(home, 'repos', 'proto'), { recursive: true });

  const previous = process.env.YAN_HOME;
  process.env.YAN_HOME = home;
  const { Task } = await import('../../src/records/task/index.js');
  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'monorepo-x', 'master', { branch: 'feat/auth', scope: ['apps/auth'] });
  new Task('t042').addUnit('proto', 'proto', 'master', { branch: 'feat/proto' });
  Task.create('t099', 'something else entirely');
  new Task('t099').addUnit('api', 'monorepo-x', 'master', { branch: 'feat/api' });
  if (previous === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previous;
});

describe('the hard path: the main agent starts in this pane', () => {
  it('reports what it started, and gives the lock back when the agent exits', () => {
    const r = yan(['continue', '--task', 't042', '--json']);
    expect(r.code, r.out).toBe(0);
    const seen = JSON.parse(r.stdout) as {
      task: string;
      agent: string;
      started: boolean;
      pane: string;
    };
    expect(seen.task).toBe('t042');
    expect(seen.started).toBe(true);
    expect(seen.agent).toBe(process.execPath);
    // Not inside Herdr in this run, and that is not a failure.
    expect(seen.pane).toBe('');

    // The lock is held for exactly as long as the agent, which is what makes it
    // able to answer "is a yan running" at all.
    expect(existsSync(lockOf('t042'))).toBe(false);
  });

  it('takes the positional form too', () => {
    const r = yan(['continue', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('starting in this pane');
  });
});

describe('a second yan on the same task', () => {
  it('is refused, and says where the live one is', () => {
    liveLock('t042', 'yan t042 pane=w9:p9');

    const r = yan(['continue', '--task', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('a second yan on the same task is refused');
    expect(r.stdout).toContain('w9:p9');
    expect(r.stdout).not.toContain('starting in this pane');
  });

  it('does not refuse a yan on a DIFFERENT task: the lock is per task', () => {
    const r = yan(['continue', '--task', 't099']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('starting in this pane');

    rmSync(lockOf('t042'));
  });

  it('reclaims a lock left behind by a process that is gone', () => {
    // pid 1 is not this yan on this host, and nothing in the tree says the
    // holder is alive. An obeyed stale lock would wedge the task for good.
    writeFileSync(
      lockOf('t042'),
      `${JSON.stringify({ pid: 999999, host: hostname(), at: 1, identity: 'yan t042' })}\n`,
    );
    const r = yan(['continue', '--task', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('starting in this pane');
    expect(existsSync(lockOf('t042'))).toBe(false);
  });
});

describe('what it refuses', () => {
  it('names the flag when there is no id and no terminal to ask in', () => {
    const r = yan(['continue']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('--task');
    expect(r.out).toContain('yan ls');
  });

  it('refuses an unknown task and two ids', () => {
    expect(yan(['continue', '--task', 'nosuchtask']).code).toBe(2);
    expect(yan(['continue', '--task', 'nosuchtask']).out).toContain('no such task');

    const two = yan(['continue', 't042', '--task', 't099']);
    expect(two.code).toBe(2);
    expect(two.out).toContain('only one task id');
  });

  it('refuses when the home configures no agents.yan, and names it', () => {
    const other = mkYanHome(join(mkTempDir(), 'home'), {
      withDist: true,
      config: `${JSON.stringify({ version: 1, agents: { shift: 'claude' }, remote_git: { kind: 'github' } }, null, 2)}\n`,
    });
    mkdirSync(join(other, 'tasks', 'tx'), { recursive: true });
    writeFileSync(
      join(other, 'tasks', 'tx', 'task.json'),
      `${JSON.stringify({ version: 1, id: 'tx', title: 'x', complete: false, units: [] })}\n`,
    );

    const r = runYan(other, ['continue', '--task', 'tx'], { HERDR_PANE_ID: '' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('agents.yan');
    expect(existsSync(join(other, 'tasks', 'tx', '.enter.lock'))).toBe(false);
  });
});

describe('the enter step itself, with the terminal and the harness injected', () => {
  interface Call {
    readonly what: string;
    readonly detail: string;
  }

  async function enter(task: string, pane: string) {
    const calls: Call[] = [];
    const started: { cli: string; argv: readonly string[]; cwd: string; env: Record<string, string> }[] = [];
    const previousHome = process.env.YAN_HOME;
    const previousPane = process.env.HERDR_PANE_ID;
    process.env.YAN_HOME = home;
    process.env.HERDR_PANE_ID = pane;
    try {
      const { enterTask } = await import('../../src/cli/continue.js');
      const session = enterTask(
        { task },
        {
          terminal: {
            workspaceOfPane: (p: string) => (p === '' ? undefined : p.split(':')[0]),
            setWorkspaceTokens: (w, t) => calls.push({ what: 'set', detail: `${w} ${JSON.stringify(t)}` }),
            clearWorkspaceTokens: (w, names) => calls.push({ what: 'clear', detail: `${w} ${names.join(',')}` }),
          },
          start: (cli, argv, options) => {
            started.push({ cli, argv, cwd: options.cwd, env: options.env });
            return 0;
          },
        },
      );
      return { calls, started, session };
    } finally {
      if (previousHome === undefined) delete process.env.YAN_HOME;
      else process.env.YAN_HOME = previousHome;
      if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
      else process.env.HERDR_PANE_ID = previousPane;
    }
  }

  it('labels the workspace before the agent starts and withdraws it when it exits', async () => {
    const { calls, session } = await enter('t042', 'w7:p2');
    expect(calls.map((c) => c.what)).toEqual(['set']);
    // Two units, so there is no single current one to name: the tab says which
    // task this is and claims nothing about a branch (display.md §4).
    expect(calls[0]?.detail).toBe('w7 {"task":"t042"}');

    expect(session.run).toBeDefined();
    expect(session.run?.()).toBe(0);
    expect(calls.map((c) => c.what)).toEqual(['set', 'clear']);
    expect(calls[1]?.detail).toBe('w7 task,unit,branch');
    expect(existsSync(lockOf('t042'))).toBe(false);
  });

  it('names the unit and the branch when the task has exactly one', async () => {
    const { calls, session } = await enter('t099', 'w7:p2');
    expect(calls[0]?.detail).toBe('w7 {"task":"t099","unit":"api","branch":"feat/api"}');
    session.run?.();
  });

  it('hands the agent every clone this task touches, and nothing else', async () => {
    const { started, session } = await enter('t042', '');
    session.run?.();
    expect(started).toHaveLength(1);
    expect(started[0]?.argv).toEqual([]); // node is not claude: no --add-dir row
    expect(started[0]?.cwd).toBe(home);
    expect(started[0]?.env.YAN_TASK).toBe('t042');
    expect(started[0]?.env.YAN_HOME).toBe(home);
  });

  it('starts nothing at all when a live yan already holds the task', async () => {
    liveLock('t042', 'yan t042 pane=w9:p9');
    const { started, calls, session } = await enter('t042', 'w7:p2');
    expect(session.record.started).toBe(false);
    expect(session.record.where).toContain('w9:p9');
    // No run half, so there is nothing that could start a duplicate — and the
    // workspace was not relabelled by a command that changed nothing.
    expect(session.run).toBeUndefined();
    expect(started).toEqual([]);
    expect(calls).toEqual([]);
    rmSync(lockOf('t042'));
  });
});

describe('yan joins, it does not host', () => {
  it('has no way to create a workspace, a tab or a pane', () => {
    const source = readFileSync(join(repoRoot, 'src', 'cli', 'continue.ts'), 'utf8');
    for (const forbidden of ['createContainer', 'workspace create', 'startAgent', 'agent focus']) {
      expect(source, `the enter step must not ${forbidden}`).not.toContain(forbidden);
    }
  });
});
