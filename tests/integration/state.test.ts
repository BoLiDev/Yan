import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { liveShift, seedT042 } from '../helpers/records.js';
import { stateOf, type AliveReader, type StateDeps } from '../../src/cli/state.js';
import type { AgentStatus, Alive } from '../../src/externals/herdr/index.js';
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

const MR = 'https://forge.invalid/acme/widget/-/merge_requests/1';
const TRAP_NOTE = 'LAST-LINE-IS-NOT-THE-STATE';

let alive: Alive = 'alive';
let attention: AgentStatus = 'working';
let mrState: MrState = 'open';
const mrCalls: { mr: string; dir: string | undefined }[] = [];

const deps = (): StateDeps => ({
  terminal: {
    agentAlive: (): Alive => alive,
    agentStatus: (): AgentStatus => attention,
  } satisfies AliveReader,
  readMrState: (ref) => {
    mrCalls.push({ mr: ref.mr, dir: ref.dir });
    return mrState;
  },
});

beforeEach(() => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  seedT042();

  run = liveShift(home, 't042', 's1', { unit: 'auth', branch: 'yan/t042/s1', tree: '', agent: 'claude', pane: 'w1:p7', mr: MR });

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
  attention = 'working';
  mrState = 'open';
  mrCalls.length = 0;
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

  it('says blocked rather than running when herdr sees a question on the screen', () => {
    // A shift sitting on an approval is alive and going nowhere, and the
    // difference is the whole thing yan has to act on: it cannot run
    // `yan report` from inside a dialog, so nothing else will say so.
    attention = 'blocked';
    const facts = stateOf('s1', 't042', deps());
    expect(facts.state).toBe('blocked');
    expect(facts.terminal, 'and it is still alive, which is why the tree is not touched').toBe('alive');
    expect(facts.attention).toBe('blocked');
  });

  it('does not ask for a status when there is no agent to ask about', () => {
    alive = 'dead';
    expect(stateOf('s1', 't042', deps()).attention).toBe('unasked');
  });

  it('lets a merged MR outrank a blocked pane too', () => {
    attention = 'blocked';
    mrState = 'merged';
    expect(stateOf('s1', 't042', deps()).state).toBe('merged');
  });

  it('says unknown out loud where nothing can be established', () => {
    alive = 'unknown';
    mrState = 'unknown';
    const facts = stateOf('s1', 't042', deps());
    expect(facts.state).toBe('unknown');
    // `unknown` is not `dead`: rounding it that way is how work gets deleted.
    expect(facts.state).not.toBe('dead');
  });

  it('reports a forge that cannot even be asked as unknown, not an error', () => {
    const facts = stateOf('s1', 't042', {
      ...deps(),
      readMrState: () => {
        throw new Error('no forge configured');
      },
    });
    expect(facts.mr_state).toBe('unknown');
    expect(facts.state).toBe('running');
  });
});

describe('run/meta.json is read defensively', () => {
  it('survives a partial file', () => {
    liveShift(home, 't042', 's1', { unit: 'auth' });
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
    liveShift(home, 't042', 's1', { unit: 'auth', branch: 'yan/t042/s1', agent: 'claude' });
    const r = await runYan(home, ['state', 's1'], { YAN_TASK: 't042' });
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('state      unknown');
    expect(r.stdout).not.toContain(TRAP_NOTE);
    expect(r.stdout).toContain('events     3');
    expect(r.stdout).toContain('events, not the state');
  });

  it('reports the same derivation as JSON', async () => {
    liveShift(home, 't042', 's1', { unit: 'auth' });
    const r = await runYan(home, ['state', 's1', '--json'], { YAN_TASK: 't042' });
    expect(r.code, r.out).toBe(0);
    const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(parsed.state).toBe('unknown');
    expect(parsed.events).toBe(3);
    expect(parsed.terminal).toBe('unknown');
    // Version 2: the pane is named as show and session-start name it.
    expect(parsed.version).toBe(2);
    expect(parsed).toHaveProperty('pane');
    expect(parsed).not.toHaveProperty('agent_id');
  });

  it('refuses a missing id, both output flags at once, and an unknown shift', async () => {
    expectUsage(await runYan(home, ['state']), 'a shift id is required');
    const both = await runYan(home, ['state', 's1', '--json', '--verdict'], { YAN_TASK: 't042' });
    expectUsage(both, '--json and --verdict are alternatives');
    expect((await runYan(home, ['state', 'nosuchshift'], { YAN_TASK: 't042' })).code).toBe(1);
  });
});

