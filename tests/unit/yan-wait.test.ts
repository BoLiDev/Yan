import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WAIT_SOURCES, watch, type EventSource, type StatusReader } from '../../src/cli/wait.js';
import { Supervision } from '../../src/records/supervision/index.js';
import { Task } from '../../src/records/task/index.js';
import type { AgentStatus, AgentStatusEvent } from '../../src/externals/herdr/index.js';
import { cleanupTempDirs, mkTempDir, mkYanHome, repoRoot } from '../helpers/fixtures.js';

/**
 * `tests/unit/yan-wait-sources.test.sh` and `yan-wait-single-flight.test.sh`,
 * ported to the two sources Phase 6 leaves: `run/signal` and Herdr's event
 * stream — plus the liveness poll, which stays because `pane_exited` cannot be
 * subscribed to (evidence §11.2).
 *
 * Nothing here sleeps for a checkpoint. Every interval is injected, the
 * terminal is a fake that answers from a map, and the event stream is a fake
 * that can be made to drop mid-watch — which is how the reconnect path is
 * tested by ENDING THE CONNECTION under it rather than by hoping.
 */

afterAll(cleanupTempDirs);

let home = '';
let previousHome: string | undefined;
let sup: Supervision;

class FakeTerminal implements StatusReader {
  public readonly status = new Map<string, AgentStatus>();
  public readonly alive = new Map<string, 'alive' | 'dead' | 'unknown'>();
  public lists = 0;

  public list(): { pane: string; status: AgentStatus }[] {
    this.lists += 1;
    return [...this.status].map(([pane, status]) => ({ pane, status }));
  }

  public agentAlive(pane: string): 'alive' | 'dead' | 'unknown' {
    return this.alive.get(pane) ?? 'alive';
  }
}

class FakeEvents implements EventSource {
  public connected = false;
  public opens = 0;
  public reconnects = 0;
  public readonly subscriptions: string[][] = [];
  public failOpenWith: Error | undefined;

  private readonly onStatusHandlers: ((event: AgentStatusEvent) => void)[] = [];
  private readonly onClosedHandlers: (() => void)[] = [];

  public async open(): Promise<void> {
    this.opens += 1;
    if (this.failOpenWith !== undefined) throw this.failOpenWith;
    this.connected = true;
  }

  public async subscribe(panes: readonly string[]): Promise<void> {
    if (panes.length > 0) this.subscriptions.push([...panes]);
  }

  public async reconnect(panes?: readonly string[]): Promise<void> {
    this.reconnects += 1;
    if (this.failOpenWith !== undefined) throw this.failOpenWith;
    this.connected = true;
    if (panes !== undefined && panes.length > 0) this.subscriptions.push([...panes]);
  }

  public onStatus(handler: (event: AgentStatusEvent) => void): void {
    this.onStatusHandlers.push(handler);
  }

  public onClosed(handler: () => void): void {
    this.onClosedHandlers.push(handler);
  }

  public close(): void {
    this.connected = false;
  }

  public emit(pane: string, status: AgentStatus): void {
    for (const handler of this.onStatusHandlers) handler({ pane, status, kind: 'claude' });
  }

  /** Herdr went away under the subscription. */
  public drop(): void {
    this.connected = false;
    for (const handler of this.onClosedHandlers) handler();
  }
}

function liveShift(sid: string, pane = 'w1:p2'): string {
  const run = join(home, 'tasks', 't1', 'shifts', sid, 'run');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'meta.json'), `{ "version": 1, "pane": "${pane}" }\n`);
  return run;
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir());
  process.env.YAN_HOME = home;
  Task.create('t1', 'supervision');
  sup = new Supervision('t1');
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('the sources are enumerable, and the fourth is still refused', () => {
  const source = readFileSync(join(repoRoot, 'src', 'cli', 'wait.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('names the pane-content hash nowhere', () => {
    // supervision.md §1 row 3: the hash is DELETED. Herdr observes the
    // condition it stood in for, from outside.
    expect(WAIT_SOURCES).toEqual(['signal', 'agent-status', 'agent-alive']);
    expect(source).not.toContain('cksum');
    expect(source).not.toContain('hash');
  });

  it('cannot reach the forge, so no source can poll CI', () => {
    for (const forbidden of ['RemoteGit', 'remote-git', 'ciState', 'mrState', 'pull_request']) {
      expect(source).not.toContain(forbidden);
    }
  });

  it('never focuses a pane', () => {
    // conventions §5, regression 5: focusing marks the tab seen, which turns
    // the `done` this command is waiting for into an `idle` it ignores.
    expect(source).not.toContain('focus');
  });
});

describe('source 1: run/signal', () => {
  it('is an edge — the reason is written down, then the marker is consumed', async () => {
    const run = liveShift('s1');
    writeFileSync(join(run, 'signal'), '');

    const result = await watch({
      task: 't1',
      seconds: 5,
      intervalSeconds: 0.05,
      terminal: new FakeTerminal(),
      events: new FakeEvents(),
    });

    expect(result.code).toBe(0);
    expect(result.reason).toContain('signal: s1');
    expect(readFileSync(sup.wake, 'utf8')).toContain('signal: s1');
    expect(existsSync(join(run, 'signal'))).toBe(false);
  });
});

describe('source 2: what herdr reports about the agent', () => {
  it('wakes on blocked, and says which shift', async () => {
    liveShift('s1');
    const events = new FakeEvents();
    const terminal = new FakeTerminal();
    terminal.status.set('w1:p2', 'working');
    const watcher = watch({ task: 't1', seconds: 5, intervalSeconds: 0.05, terminal, events });
    setTimeout(() => events.emit('w1:p2', 'blocked'), 20);

    const result = await watcher;
    expect(result.code).toBe(0);
    expect(result.reason).toContain('blocked: s1');
    expect(readFileSync(sup.wake, 'utf8')).toContain('blocked: s1');
  });

  it('wakes on done — and tears nothing down, because done is not a verdict', async () => {
    // evidence §11.3: plan approval arrives as `done`. A shift parked on a plan
    // approval therefore looks exactly like a shift that has finished, and
    // clocking out is destructive. Rule 3 is the objective condition.
    const run = liveShift('s1');
    const events = new FakeEvents();
    const watcher = watch({
      task: 't1',
      seconds: 5,
      intervalSeconds: 0.05,
      terminal: new FakeTerminal(),
      events,
    });
    setTimeout(() => events.emit('w1:p2', 'done'), 20);

    const result = await watcher;
    expect(result.code).toBe(0);
    expect(result.reason).toContain('done: s1');
    expect(result.reason).toContain('merged into the integration branch');

    // Nothing was torn down: run/ is still there, meta.json is still there, and
    // the shift is still live as far as anything else is concerned.
    expect(existsSync(run)).toBe(true);
    expect(existsSync(join(run, 'meta.json'))).toBe(true);
    expect(sup.liveCount()).toBe(1);
  });

  it.each(['idle', 'working', 'unknown'] as const)('does not act on %s', async (status) => {
    liveShift('s1');
    const events = new FakeEvents();
    const watcher = watch({
      task: 't1',
      seconds: 1,
      intervalSeconds: 0.05,
      terminal: new FakeTerminal(),
      events,
    });
    setTimeout(() => events.emit('w1:p2', status), 20);

    const result = await watcher;
    expect(result.code).toBe(124);
    expect(existsSync(sup.wake)).toBe(false);
  });

  it('takes a snapshot after subscribing, so a shift already blocked is not missed', async () => {
    // The window supervision.md §2 closes: a subscription is an edge trigger,
    // so a `yan wait` starting up over shifts that are already running would
    // never hear about a block that happened before it was listening.
    liveShift('s1');
    const terminal = new FakeTerminal();
    terminal.status.set('w1:p2', 'blocked');
    const events = new FakeEvents();

    const result = await watch({
      task: 't1',
      seconds: 5,
      intervalSeconds: 0.05,
      terminal,
      events,
    });
    expect(result.code).toBe(0);
    expect(result.reason).toContain('blocked: s1');
    expect(events.subscriptions[0]).toEqual(['w1:p2']);
  });
});

describe('source 3: the liveness poll that has no push channel', () => {
  it('reports an agent that died, and does not repeat an undrained reason', async () => {
    liveShift('s1');
    const terminal = new FakeTerminal();
    terminal.alive.set('w1:p2', 'dead');

    const first = await watch({
      task: 't1',
      seconds: 5,
      intervalSeconds: 0.05,
      terminal,
      events: new FakeEvents(),
    });
    expect(first.code).toBe(0);
    expect(first.reason).toContain('died: s1');

    // A LEVEL, not an edge: the agent is still dead. With the reason still
    // sitting undrained, a rearmed watcher must not wake the model again.
    const second = await watch({
      task: 't1',
      seconds: 1,
      intervalSeconds: 0.05,
      terminal,
      events: new FakeEvents(),
    });
    expect(second.code).toBe(124);

    // Once it has been drained, the fact is news again.
    rmSync(sup.wake, { force: true });
    const third = await watch({
      task: 't1',
      seconds: 5,
      intervalSeconds: 0.05,
      terminal,
      events: new FakeEvents(),
    });
    expect(third.code).toBe(0);
    expect(third.reason).toContain('died: s1');
  });

  it("never rounds 'unknown' up to 'dead'", async () => {
    liveShift('s1');
    const terminal = new FakeTerminal();
    terminal.alive.set('w1:p2', 'unknown');

    const result = await watch({
      task: 't1',
      seconds: 1,
      intervalSeconds: 0.05,
      terminal,
      events: new FakeEvents(),
    });
    expect(result.code).toBe(124);
    expect(existsSync(sup.wake)).toBe(false);
  });
});

describe('a subscription that ends', () => {
  it('is reconnected from disk, and snapshotted on the way back in', async () => {
    const terminal = new FakeTerminal();
    const events = new FakeEvents();
    liveShift('s1');
    terminal.status.set('w1:p2', 'working');

    const watcher = watch({ task: 't1', seconds: 5, intervalSeconds: 0.05, terminal, events });

    setTimeout(() => {
      // A shift dispatched while the connection was down: the reconnect has to
      // re-read run/meta.json, not restore what this process was holding.
      liveShift('s2', 'w1:p9');
      events.drop();
      // …and the block happened while nobody was listening. Only a snapshot on
      // the way back in can find it.
      terminal.status.set('w1:p9', 'blocked');
    }, 30);

    const result = await watcher;
    expect(result.code).toBe(0);
    expect(result.reason).toContain('blocked: s2');
    expect(events.reconnects).toBeGreaterThan(0);
    expect(events.subscriptions[events.subscriptions.length - 1]).toEqual(['w1:p2', 'w1:p9']);
  });

  it('keeps watching on the poll when it cannot be re-established', async () => {
    liveShift('s1');
    const terminal = new FakeTerminal();
    const events = new FakeEvents();
    const notes: string[] = [];

    const watcher = watch({
      task: 't1',
      seconds: 5,
      intervalSeconds: 0.05,
      terminal,
      events,
      note: (line) => notes.push(line),
    });
    setTimeout(() => {
      events.failOpenWith = new Error('herdr went away');
      events.drop();
      terminal.status.set('w1:p2', 'blocked');
    }, 30);

    const result = await watcher;
    // The fact still arrives — one poll late, on `agent list`, which is the
    // Phase 5 gate's fallback and still facts rather than a content hash.
    expect(result.code).toBe(0);
    expect(result.reason).toContain('blocked: s1');
    expect(notes.join('\n')).toContain('still watching, on the poll');
  });

  it('starts degraded rather than not at all when the socket is not there', async () => {
    liveShift('s1');
    const terminal = new FakeTerminal();
    terminal.status.set('w1:p2', 'blocked');
    const events = new FakeEvents();
    events.failOpenWith = new Error('cannot reach the event socket');
    const notes: string[] = [];

    const result = await watch({
      task: 't1',
      seconds: 5,
      intervalSeconds: 0.05,
      terminal,
      events,
      note: (line) => notes.push(line),
    });
    expect(result.code).toBe(0);
    expect(notes.join('\n')).toContain('falling back to polling');
  });
});

describe('single flight', () => {
  it('refuses to start a second watcher while one is on duty', async () => {
    liveShift('s1');
    expect(sup.claimLock()).toBe(true);
    sup.touchBeacon('subscribed');

    const result = await watch({
      task: 't1',
      seconds: 5,
      intervalSeconds: 0.05,
      terminal: new FakeTerminal(),
      events: new FakeEvents(),
    });
    expect(result.code).toBe(4);
    // The refusal changed nothing: the first watcher still holds the lock.
    expect(sup.lockTaken()).toBe(true);
    sup.releaseLock();
  });

  it('holds the lock while it runs and gives it back however it ends', async () => {
    liveShift('s1');
    const terminal = new FakeTerminal();
    const events = new FakeEvents();
    const watcher = watch({ task: 't1', seconds: 1, intervalSeconds: 0.05, terminal, events });

    // While it is running the lock is a watcher's, and the beacon moves.
    await new Promise((r) => setTimeout(r, 60));
    expect(sup.lockTaken()).toBe(true);
    expect(sup.healthy()).toBe(true);
    expect(sup.beaconAgeSeconds()).toBeLessThan(5);

    expect((await watcher).code).toBe(124);
    expect(sup.lockTaken()).toBe(false);
    expect(existsSync(sup.lock)).toBe(false);
  });

  it('reclaims a lock left behind by a process that is gone', async () => {
    const run = liveShift('s1');
    writeFileSync(join(run, 'signal'), '');
    mkdirSync(sup.run, { recursive: true });
    writeFileSync(
      sup.lock,
      `${JSON.stringify({ pid: 999_999, host: (await import('node:os')).hostname(), at: 1, identity: 'yan-wait t1' })}\n`,
    );

    const result = await watch({
      task: 't1',
      seconds: 5,
      intervalSeconds: 0.05,
      terminal: new FakeTerminal(),
      events: new FakeEvents(),
    });
    expect(result.code).toBe(0);
    expect(result.reason).toContain('signal: s1');
  });
});

describe('the quiet ends', () => {
  it('exits 3 when there is nothing to supervise, and writes nothing', async () => {
    const result = await watch({
      task: 't1',
      intervalSeconds: 0.05,
      terminal: new FakeTerminal(),
      events: new FakeEvents(),
    });
    expect(result.code).toBe(3);
    expect(result.reason).toBeUndefined();
    expect(existsSync(sup.wake)).toBe(false);
  });

  it('exits 3 when the last shift clocks out under it', async () => {
    liveShift('s1');
    const watcher = watch({
      task: 't1',
      seconds: 5,
      intervalSeconds: 0.05,
      terminal: new FakeTerminal(),
      events: new FakeEvents(),
    });
    setTimeout(() => {
      rmSync(join(home, 'tasks', 't1', 'shifts', 's1', 'run'), { recursive: true, force: true });
    }, 30);

    expect((await watcher).code).toBe(3);
    expect(existsSync(sup.wake)).toBe(false);
  });

  it('exits 124 when a bounded slice ends with shifts still live', async () => {
    liveShift('s1');
    const result = await watch({
      task: 't1',
      seconds: 1,
      intervalSeconds: 0.05,
      terminal: new FakeTerminal(),
      events: new FakeEvents(),
    });
    expect(result.code).toBe(124);
    expect(existsSync(sup.wake)).toBe(false);
  });
});

describe('a shift with no recorded pane', () => {
  it('is still watched through its own channel', async () => {
    // A shift dispatched by an older yan, or one whose ids were never recorded,
    // still has a signal file. It must not be dropped from supervision.
    const run = join(home, 'tasks', 't1', 'shifts', 's1', 'run');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'meta.json'), '{ "version": 1 }\n');
    writeFileSync(join(run, 'signal'), '');

    const result = await watch({
      task: 't1',
      seconds: 5,
      intervalSeconds: 0.05,
      terminal: new FakeTerminal(),
      events: new FakeEvents(),
    });
    expect(result.code).toBe(0);
    expect(result.reason).toContain('signal: s1');
  });
});

describe('a pane herdr has never heard of', () => {
  it('is never subscribed to, because asking closes the whole connection', async () => {
    // evidence §12.1, measured against a real herdr: a subscription naming an
    // unknown pane is not refused with an error — the server drops the
    // connection, taking every other pane's subscription with it. A stale id in
    // run/meta.json would otherwise cost the watcher its event stream once per
    // turn, for ever.
    liveShift('s1', 'w1:p2');
    liveShift('s2', 'w1:p7');
    const terminal = new FakeTerminal();
    terminal.status.set('w1:p2', 'working');
    const events = new FakeEvents();

    const result = await watch({ task: 't1', seconds: 1, intervalSeconds: 0.05, terminal, events });
    expect(result.code).toBe(124);
    for (const request of events.subscriptions) expect(request).toEqual(['w1:p2']);
    expect(events.subscriptions).toHaveLength(1);
    expect(events.reconnects).toBe(0);
  });
});

describe('a shift whose recorded pane id Herdr would not know', () => {
  it('does not cost the other shifts their subscription', async () => {
    // A subscription naming one unknown pane is refused WHOLE, so it is left
    // out — that shift keeps run/signal and the poll, which is what a shift
    // with no usable pane had all along. `%7` here is a tmux id, the shape
    // Phase 9 deleted the producer of; what still produces one is run/meta.json
    // outliving the yan that wrote it, and the empty string `shift new` records
    // before the agent starts.
    liveShift('s1', '%7');
    liveShift('s2', 'w1:p3');
    const events = new FakeEvents();
    const terminal = new FakeTerminal();
    terminal.status.set('w1:p3', 'working');
    const watcher = watch({ task: 't1', seconds: 5, intervalSeconds: 0.05, terminal, events });
    setTimeout(() => events.emit('w1:p3', 'blocked'), 20);

    const result = await watcher;
    expect(result.code).toBe(0);
    expect(result.reason).toContain('blocked: s2');
    expect(events.subscriptions[0]).toEqual(['w1:p3']);
  });
});

describe('the socket client lives with the rest of Herdr', () => {
  it('is a file in the herdr module, with its own test, behind one index.ts', () => {
    // Phase 6 gave it a module of its own, `externals/terminal-events`. That
    // was one module too many: `externals` may not import each other, so the
    // pane-id shape and the agent-status union were each written twice and a
    // test existed only to police the copies. Two transports, one authority,
    // one module.
    const files = readdirSync(join(repoRoot, 'src', 'externals', 'herdr'));
    expect(files).toContain('index.ts');
    expect(files).toContain('events.ts');
    expect(files).toContain('events.test.ts');
    // The CLI transport is in the same module, which is the whole point.
    expect(files).toContain('terminal.ts');
    expect(files).toContain('ids.ts');
  });

  it('and there is no second Herdr module for it to drift from', () => {
    // One outside authority, one module. The list grows when yan learns about a
    // new authority — Phase 7 added `conf-hook` for `conf/hooks/` — but no
    // authority may ever appear twice, which is what this pins.
    const externals = readdirSync(join(repoRoot, 'src', 'externals')).sort();
    expect(externals.filter((n) => /herdr|terminal|event|pane/.test(n))).toEqual(['herdr']);
    expect(externals).toContain('remote-git');
    expect(externals).toContain('worktree');
    expect(new Set(externals).size).toBe(externals.length);
  });
});
