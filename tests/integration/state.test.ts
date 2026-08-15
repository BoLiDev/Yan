import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { stateOf, type AliveReader, type StateDeps } from '../../src/cli/state.js';
import { Task } from '../../src/records/task/index.js';
import type { Alive } from '../../src/externals/herdr/index.js';
import type { MrState } from '../../src/externals/remote-git/index.js';

/**
 * `yan state` derives from the live sources and never from the event log. The
 * status file below is a trap: its last line says `done`, with a note nobody
 * could produce by accident, while the terminal and the host say something
 * else. That note appearing in the output means the log is being read as a
 * state.
 */

afterAll(cleanupTempDirs);

let home = '';
let run = '';
let previousHome: string | undefined;

const MR = 'https://forge.invalid/acme/widget/-/merge_requests/1';
const TRAP_NOTE = 'LAST-LINE-IS-NOT-THE-STATE';

let alive: Alive = 'alive';
let mrState: MrState = 'open';
const mrCalls: { mr: string; dir: string | undefined }[] = [];

const deps = (): StateDeps => ({
  terminal: { agentAlive: (): Alive => alive } satisfies AliveReader,
  readMrState: (mr, dir) => {
    mrCalls.push({ mr, dir });
    return mrState;
  },
});

function meta(body: Record<string, unknown>): void {
  writeFileSync(join(run, 'meta.json'), `${JSON.stringify({ version: 1, ...body })}\n`);
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir(), { withDist: true });
  process.env.YAN_HOME = home;
  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'monorepo-x', 'master', { branch: 'feat/auth', scope: ['apps/auth'] });

  run = join(home, 'tasks', 't042', 'shifts', 's1', 'run');
  mkdirSync(run, { recursive: true });
  meta({ unit: 'auth', branch: 'yan/t042/s1', tree: '', agent: 'claude', pane: 'w1:p7', mr: MR });

  // The trap: the newest event says `done`.
  writeFileSync(
    join(run, 'status'),
    [
      '2026-08-09T09:00:00Z\tstarted\tread the brief',
      '2026-08-09T10:00:00Z\tblocked\twaiting for a credential',
      `2026-08-09T11:00:00Z\tdone\t${TRAP_NOTE}`,
      '',
    ].join('\n'),
  );

  alive = 'alive';
  mrState = 'open';
  mrCalls.length = 0;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('the live sources decide, never the newest event', () => {
  it('reports running while the agent is alive and the MR is still open', () => {
    expect(stateOf('s1', 't042', deps()).state).toBe('running');
  });

  it('counts run/status and refuses to interpret it', () => {
    const facts = stateOf('s1', 't042', deps());
    expect(facts.events, 'run/status is counted and nothing else').toBe(3);
    expect(JSON.stringify(facts), 'the newest event must not be surfaced').not.toContain(TRAP_NOTE);
  });

  it('lets a dead terminal outrank a `done` event', () => {
    alive = 'dead';
    expect(stateOf('s1', 't042', deps()).state).toBe('dead');
  });

  it('lets a merged MR outrank whatever the pane says', () => {
    mrState = 'merged';
    expect(stateOf('s1', 't042', deps()).state, 'the objective end condition is the MR').toBe('merged');
    // The host really was asked, in yan vocabulary and with the recorded MR.
    expect(mrCalls).toEqual([{ mr: MR, dir: undefined }]);
  });

  it('says unknown out loud where nothing can be established', () => {
    alive = 'unknown';
    mrState = 'unknown';
    const facts = stateOf('s1', 't042', deps());
    expect(facts.state).toBe('unknown');
    // `unknown` is not `dead`: rounding it that way is how work gets deleted.
    expect(facts.state).not.toBe('dead');
  });
});

describe('run/meta.json is read defensively', () => {
  it('survives a partial file', () => {
    meta({ unit: 'auth' });
    const facts = stateOf('s1', 't042', deps());
    expect(facts.state).toBe('unknown');
    expect(facts.terminal_why).toContain('no terminal id');
    expect(facts.mr_state).toBe('none');
  });

  it('survives a file that is not JSON at all', () => {
    writeFileSync(join(run, 'meta.json'), 'not json at all\n');
    expect(stateOf('s1', 't042', deps()).state).toBe('unknown');
  });

  it('survives a missing file, and still counts the events', () => {
    rmSync(join(run, 'meta.json'));
    const facts = stateOf('s1', 't042', deps());
    expect(facts.state).toBe('unknown');
    expect(facts.events).toBe(3);
  });
});

describe('run/ gone means clocked out', () => {
  it('checks that first, because every other source is about a running shift', () => {
    rmSync(run, { recursive: true, force: true });
    expect(stateOf('s1', 't042', deps()).state).toBe('clocked-out');
  });
});

describe('through bin/yan', () => {
  it('renders the human view without surfacing the newest event', async () => {
    meta({ unit: 'auth', branch: 'yan/t042/s1', agent: 'claude' });
    const r = await runYan(home, ['state', 's1', '--task', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('state      unknown');
    expect(r.stdout).not.toContain(TRAP_NOTE);
    expect(r.stdout).toContain('events     3');
    expect(r.stdout).toContain('events, not the state');
  });

  it('reports the same derivation as JSON', async () => {
    meta({ unit: 'auth' });
    const r = await runYan(home, ['state', 's1', '--task', 't042', '--json']);
    expect(r.code, r.out).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.state).toBe('unknown');
    expect(parsed.events).toBe(3);
    expect(parsed.terminal).toBe('unknown');
  });

  it('refuses a missing id, both output flags at once, and an unknown shift', async () => {
    expect((await runYan(home, ['state'])).code, 'a shift id is required').toBe(2);
    const both = await runYan(home, ['state', 's1', '--json', '--verdict', '--task', 't042']);
    expect(both.code, '--json and --verdict are alternatives').toBe(2);
    expect((await runYan(home, ['state', 'nosuchshift', '--task', 't042'])).code).toBe(1);
  });
});

describe('the pulse says whether the terminal is moving', () => {
  function pulse(changedAgo: number, seenAgo: number): void {
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(run, 'pulse'), `${now - changedAgo} ${now - seenAgo} deadbeefdeadbeef\n`);
  }

  it('says nothing at all when no watcher has taken a reading', async () => {
    // With nobody sampling, "unchanged" is a fact about the watcher rather
    // than about the shift.
    const r = await runYan(home, ['state', 's1', '--task', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('pulse      unsampled');
    expect(r.stdout).toContain('yan wait');
  });

  it('and says so again when the last reading is too old to be about the shift', async () => {
    pulse(600, 600);
    const r = await runYan(home, ['state', 's1', '--task', 't042']);
    expect(r.stdout).toContain('pulse      unsampled');
    expect(r.stdout, 'and how stale it is, so the reason is visible').toContain('last read');
  });

  it('reports movement, with how long ago', async () => {
    pulse(2, 0);
    const r = await runYan(home, ['state', 's1', '--task', 't042']);
    expect(r.stdout).toContain('pulse      moving');
  });

  it('reports stillness as a duration, and never as a verdict', async () => {
    pulse(380, 0);
    const r = await runYan(home, ['state', 's1', '--task', 't042']);
    expect(r.stdout).toContain('pulse      still');
    expect(r.stdout).toMatch(/6m\d\ds/);
    // An install is still for minutes and so is a model thinking, so the line
    // reports a duration and never calls it stuck.
    expect(r.stdout).toContain('not the same as stuck');
    expect(r.stdout).not.toMatch(/^pulse\s+stuck/m);
  });

  it('carries the numbers into the JSON, so nothing has to parse the prose', async () => {
    pulse(380, 1);
    const r = await runYan(home, ['state', 's1', '--task', 't042', '--json']);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.motion).toBe('still');
    // Ranges, not equalities: spawning the command costs real wall clock.
    expect(parsed.still_for as number).toBeGreaterThanOrEqual(375);
    expect(parsed.still_for as number).toBeLessThanOrEqual(385);
    expect(parsed.sampled_ago as number).toBeLessThanOrEqual(10);
  });
});
