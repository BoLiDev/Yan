import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { stateOf, type AliveReader, type StateDeps } from '../../src/cli/state.js';
import { Task } from '../../src/records/task/index.js';
import type { Alive } from '../../src/externals/herdr/index.js';
import type { MrState } from '../../src/externals/remote-git/index.js';

/**
 * `yan state`, ported from `tests/unit/yan-state.test.sh` and the state half of
 * `tests/integration/yan-send-state.test.sh`.
 *
 * Every line in run/status is an event, and `yan state` does not treat the last
 * one as the current state. The status file below is built so that its last
 * line is a trap: it says `done`, with a note nobody could produce by accident.
 * Each case then puts the live sources — the terminal and the host — somewhere
 * else entirely and requires `yan state` to report what they say. If the answer
 * ever comes back `done`, or the trap note ever appears in the output, this
 * command has started reading the event stream as a state.
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
    // orchestration.md §6: `unknown` is not `dead`. Rounding it that way is how
    // work gets deleted.
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
    expect(r.stdout).toContain('EVENTS, not the state');
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
