import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, registerRepo, runYan } from '../helpers/fixtures.js';
import { abandonShift, abandonTask, type AbandonDeps } from '../../src/cli/abandon.js';
import { Task } from '../../src/records/task/index.js';
import type { MrState } from '../../src/externals/remote-git/index.js';
import type { LeaseRow, ReturnOptions } from '../../src/externals/worktree/index.js';

/**
 * Giving work up. What must hold: nothing happens without user's word and a
 * reason; an open merge request is closed and a merged one is not; the agent,
 * run/ and the tree go; the brief, outcome.md and every branch stay; and a
 * forge or terminal that will not cooperate is reported, not obeyed.
 */

afterAll(cleanupTempDirs);

const MR = 'https://forge.invalid/acme/widget/-/merge_requests/31';
const OUTBOUND = 'https://forge.invalid/acme/widget/-/merge_requests/88';

let home = '';
let clone = '';
let previousHome: string | undefined;
let calls: string[] = [];
let leases: LeaseRow[] = [];
let states: Record<string, MrState> = {};
let closeFails = false;
let agentStays = false;

function deps(): AbandonDeps {
  return {
    terminal: {
      close: (pane) => calls.push(`pane_close ${pane}`),
      clearPaneTitle: () => {},
      agentAlive: () => (agentStays ? 'alive' : 'dead'),
    },
    pool: () => ({
      status: () => leases,
      return: (path: string, options: ReturnOptions = {}) => {
        calls.push(`pool_return ${path} force=${String(options.force === true)}`);
        leases = leases.filter((l) => l.path !== path);
        return path;
      },
    }),
    mrStateOf: (mr) => {
      calls.push(`mr_state ${mr}`);
      return states[mr] ?? 'open';
    },
    closeMr: (mr) => {
      calls.push(`mr_close ${mr}`);
      if (closeFails) throw new Error('the host said no');
    },
  };
}

function liveShift(sid: string, extra: Record<string, unknown> = {}): string {
  const dir = join(home, 'tasks', 't042', 'shifts', sid);
  mkdirSync(join(dir, 'run'), { recursive: true });
  writeFileSync(join(dir, 'brief.md'), `# ${sid}\n`);
  writeFileSync(join(dir, 'outcome.md'), `# ${sid} outcome\n`);
  const tree = join(home, 'trees', sid);
  writeFileSync(
    join(dir, 'run', 'meta.json'),
    JSON.stringify({ version: 1, task: 't042', sid, unit: 'auth', branch: `yan/t042-auth-${sid}`, tree, clone, holder: `t042/auth/${sid}`, lease_id: `lease-${sid}`, pane: 'w1:p7', scenario: 'coding', ...extra }),
  );
  writeFileSync(join(dir, 'run', 'status'), `2026-09-11T08:00:00Z\tdone\tmr ${MR}\n`);
  leases.push({ slot: leases.length + 1, path: tree, branch: `yan/t042-auth-${sid}`, base: 'feat/auth', holder: `t042/auth/${sid}`, lease_id: `lease-${sid}`, at: 0 });
  return dir;
}

function log(): string {
  return readFileSync(join(home, 'tasks', 't042', 'log.md'), 'utf8');
}

function attempt(fn: () => unknown): { code: number; message: string } {
  try {
    fn();
    return { code: 0, message: '' };
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { code: e.exitCode ?? 1, message: e.message ?? '' };
  }
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(join(mkTempDir(), 'home'), { withDist: true });
  process.env.YAN_HOME = home;
  clone = join(home, 'repos', 'widget');
  mkdirSync(clone, { recursive: true });
  registerRepo(home, 'widget', clone);
  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'widget', 'main', { branch: 'feat/auth' });
  calls = [];
  leases = [];
  states = {};
  closeFails = false;
  agentStays = false;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('yan shift abandon', () => {
  it("touches nothing without user's word, or without a reason", () => {
    const dir = liveShift('s1');
    const noConsent = attempt(() => abandonShift('s1', { reason: 'not needed' }, deps()));
    expect(noConsent.code).toBe(2);
    expect(noConsent.message).toContain('--user-asked');
    const noReason = attempt(() => abandonShift('s1', { userAsked: true }, deps()));
    expect(noReason.code).toBe(2);
    expect(noReason.message).toContain('--reason');
    expect(existsSync(join(dir, 'run'))).toBe(true);
    expect(calls).toEqual([]);
  });

  it('closes the open merge request, kills the agent, discards the tree, and keeps the record', () => {
    const dir = liveShift('s1');
    const r = abandonShift('s1', { userAsked: true, reason: 'user dropped the feature' }, deps());

    expect(r.mr_closing).toBe('closed');
    expect(calls).toEqual([
      `mr_state ${MR}`,
      `mr_close ${MR}`,
      'pane_close w1:p7',
      `pool_return ${join(home, 'trees', 's1')} force=true`,
    ]);
    expect(existsSync(join(dir, 'run')), 'run/ goes').toBe(false);
    expect(existsSync(join(dir, 'brief.md')), 'the brief stays').toBe(true);
    expect(existsSync(join(dir, 'outcome.md')), 'the outcome stays').toBe(true);
    expect(log()).toMatch(/changed {4}s1 auth {2}abandoned; \S+ closed — user dropped the feature/);
  });

  it('never closes a merge request that already merged', () => {
    liveShift('s1');
    states[MR] = 'merged';
    const r = abandonShift('s1', { userAsked: true, reason: 'enough' }, deps());
    expect(r.mr_closing).toBe('merged');
    expect(calls.some((c) => c.startsWith('mr_close'))).toBe(false);
  });

  it('still gives the work up when the host will not close the request, and says so', () => {
    const dir = liveShift('s1');
    closeFails = true;
    const r = abandonShift('s1', { userAsked: true, reason: 'enough' }, deps());
    expect(r.mr_closing).toBe('failed');
    expect(existsSync(join(dir, 'run'))).toBe(false);
    expect(log()).toContain('could NOT be closed');
  });

  it('asks the host nothing about an explore shift, which opened no request', () => {
    liveShift('s1', { scenario: 'explore' });
    expect(abandonShift('s1', { userAsked: true, reason: 'enough' }, deps()).mr_closing).toBe('none');
    expect(calls.some((c) => c.startsWith('mr_'))).toBe(false);
  });

  it('reports an agent still in its pane', () => {
    liveShift('s1');
    agentStays = true;
    const r = abandonShift('s1', { userAsked: true, reason: 'enough' }, deps());
    expect(r.pane_closed).toBe(false);
    expect(r.pane).toBe('w1:p7');
  });

  it('refuses a shift that is not live', () => {
    mkdirSync(join(home, 'tasks', 't042', 'shifts', 's9'), { recursive: true });
    expect(attempt(() => abandonShift('s9', { userAsked: true, reason: 'x' }, deps())).message).toContain('not live');
  });
});

describe('yan abandon', () => {
  it('abandons every shift, closes the outbound request, returns every tree, and marks the task', async () => {
    liveShift('s1');
    liveShift('s2');
    new Task('t042').editUnit('auth', (u) => {
      u.mr = OUTBOUND;
    });
    const standing = join(home, 'trees', 'standing');
    leases.push({ slot: 9, path: standing, branch: 'feat/auth', base: 'feat/auth', holder: 't042/auth', lease_id: 'lease-standing', at: 0 });

    const r = abandonTask({ task: 't042', userAsked: true, reason: 'the client cancelled it' }, deps());

    expect(r.shifts.map((s) => s.sid)).toEqual(['s1', 's2']);
    expect(r.outbound).toEqual([{ unit: 'auth', mr: OUTBOUND, mr_closing: 'closed' }]);
    expect(r.trees, 'the standing tree goes back too').toEqual([{ holder: 't042/auth', path: standing, returned: true }]);
    expect(leases).toEqual([]);

    const task = new Task('t042').read();
    expect(task.abandoned).toBe(true);
    expect(task.complete).toBe(true);
    expect(log()).toMatch(/changed {4}task abandoned; s1 s2 torn down; 3 merge request\(s\) closed — the client cancelled it/);

    const listed = await runYan(home, ['ls']);
    expect(listed.stdout).toMatch(/t042 +abandoned/);
    const shown = await runYan(home, ['show', 't042']);
    expect(shown.stdout).toContain('✗ abandoned');
  });

  it("refuses without user's word, a task already done, and one already abandoned", () => {
    expect(attempt(() => abandonTask({ task: 't042', reason: 'x' }, deps())).message).toContain('--user-asked');
    new Task('t042').setComplete(true);
    expect(attempt(() => abandonTask({ task: 't042', userAsked: true, reason: 'x' }, deps())).message).toContain('is done');
    new Task('t042').setAbandoned();
    expect(attempt(() => abandonTask({ task: 't042', userAsked: true, reason: 'x' }, deps())).message).toContain('already abandoned');
    expect(calls).toEqual([]);
  });
});
