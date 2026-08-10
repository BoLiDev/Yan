import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Supervision } from './index.js';
import { readBeacon } from './beacon.js';
import { Task } from '../task/index.js';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';

/**
 * `tests/unit/lib-watch-health.test.sh`, ported: "the watcher is healthy" means
 * ALL of — the lock exists and its pid is alive, the identity matches, and the
 * beacon is fresh.
 *
 * BOTH DIRECTIONS ARE TESTED, because each one on its own is a lie a session
 * can run on for hours:
 *
 *   a live pid with a stale beacon    the watcher is there but has stopped
 *                                     looping. A pid is not attendance
 *   a fresh beacon with no lock       a file left behind by a watcher that is
 *                                     gone. A timestamp is not a process
 *
 * No sleeping: the beacon carries its own epoch, so a stale one is written, not
 * waited for.
 */

afterAll(cleanupTempDirs);

let home = '';
let previousHome: string | undefined;
let sup: Supervision;

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir());
  process.env.YAN_HOME = home;
  Task.create('t1', 'supervision');
  sup = new Supervision('t1');
  mkdirSync(sup.run, { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

function freshBeacon(pid = process.pid): void {
  writeFileSync(sup.beacon, `${Math.floor(Date.now() / 1000)} ${pid} t1 subscribed\n`);
}

function agedBeacon(seconds: number, pid = process.pid): void {
  writeFileSync(sup.beacon, `${Math.floor(Date.now() / 1000) - seconds} ${pid} t1 subscribed\n`);
}

function liveLock(identity = 'yan-wait t1', pid = process.pid): void {
  writeFileSync(sup.lock, `${JSON.stringify({ pid, host: hostname(), at: 1, identity })}\n`);
}

function clearAll(): void {
  rmSync(sup.lock, { force: true, recursive: true });
  rmSync(sup.beacon, { force: true });
}

function liveShift(sid: string, pane = 'w1:p2'): void {
  const run = join(home, 'tasks', 't1', 'shifts', sid, 'run');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'meta.json'), `{ "version": 1, "pane": "${pane}" }\n`);
}

describe('where the four files are', () => {
  it('is under the task, beside the wake file yan drain already reads', () => {
    expect(sup.run).toBe(join(home, 'tasks', 't1', 'run'));
    expect(sup.wake).toBe(join(sup.run, 'wake'));
    expect(sup.lock).toBe(join(sup.run, 'wait.lock'));
    expect(sup.beacon).toBe(join(sup.run, 'beacon'));
    expect(sup.guard).toBe(join(sup.run, 'guard-failures'));
  });
});

describe('is anybody on duty', () => {
  it('says no to nothing at all', () => {
    clearAll();
    expect(sup.healthy()).toBe(false);
    expect(sup.lockTaken()).toBe(false);
  });

  it('separates "the lock is taken" from "the watcher is healthy"', () => {
    // That split is the guard's 800 ms question: a watcher that has just
    // claimed the lock has not necessarily finished its first loop yet.
    clearAll();
    liveLock();
    expect(sup.lockTaken()).toBe(true);
    expect(sup.healthy()).toBe(false);
    expect(sup.why()).toContain('beacon');
  });

  it('says yes when the lock, the identity and the beacon all agree', () => {
    clearAll();
    liveLock();
    freshBeacon();
    expect(sup.healthy()).toBe(true);
    expect(sup.why()).toBe('');
  });

  it('direction one: a live pid with a stale beacon is not a watcher', () => {
    clearAll();
    liveLock();
    agedBeacon(4_000);
    expect(sup.healthy()).toBe(false);
    expect(sup.why()).toContain('beacon');

    // The threshold is a parameter, and the default is 300s.
    agedBeacon(301);
    expect(sup.healthy()).toBe(false);
    expect(sup.healthy(400)).toBe(true);

    // $YAN_WATCH_BEACON_MAX moves it, as it did in the shell half: both are on
    // disk together, and a machine that tuned one must not find the other on a
    // different number.
    process.env.YAN_WATCH_BEACON_MAX = '400';
    try {
      expect(sup.healthy()).toBe(true);
    } finally {
      delete process.env.YAN_WATCH_BEACON_MAX;
    }
  });

  it('direction two: a fresh beacon with no lock is not a watcher', () => {
    clearAll();
    freshBeacon();
    expect(sup.healthy()).toBe(false);
    expect(sup.lockTaken()).toBe(false);
  });

  it('refuses a lock whose owner is gone', () => {
    clearAll();
    liveLock('yan-wait t1', 999_999);
    freshBeacon(999_999);
    expect(sup.healthy()).toBe(false);
    expect(sup.why()).toContain('owner is gone');
  });

  it('refuses a lock that belongs to something else', () => {
    // tasks/<id>/.enter.lock is a real live lock in the same tree that has
    // nothing to do with supervision.
    clearAll();
    liveLock('yan-continue t1');
    freshBeacon();
    expect(sup.healthy()).toBe(false);
    expect(sup.why()).toContain('yan-continue t1');
  });

  it('refuses a beacon written by somebody other than the lock holder', () => {
    clearAll();
    liveLock();
    freshBeacon(424_242);
    expect(sup.healthy()).toBe(false);
    expect(sup.why()).toContain('424242');
  });

  it("reads the shell half's lock, so the two halves can meet on one task", () => {
    // For the length of the migration a bash `yan wait` and a TypeScript guard
    // can be on the same task. lib-lock.sh takes a DIRECTORY.
    clearAll();
    mkdirSync(sup.lock, { recursive: true });
    writeFileSync(join(sup.lock, 'pid'), `${process.pid}\n`);
    writeFileSync(join(sup.lock, 'identity'), 'yan-wait t1\n');
    freshBeacon();
    expect(sup.lockTaken()).toBe(true);
    expect(sup.healthy()).toBe(true);

    // And it is never reclaimed as if it were a stale file of ours.
    expect(sup.claimLock()).toBe(false);
    expect(existsSync(join(sup.lock, 'pid'))).toBe(true);
  });
});

describe('the single-flight lock', () => {
  it('is taken once, and says what it is for', () => {
    clearAll();
    expect(sup.claimLock()).toBe(true);
    expect(sup.lockTaken()).toBe(true);
    expect(readFileSync(sup.lock, 'utf8')).toContain('yan-wait t1');

    // A second claim by this process finds it taken.
    expect(sup.claimLock()).toBe(false);

    sup.releaseLock();
    expect(existsSync(sup.lock)).toBe(false);
    expect(sup.lockTaken()).toBe(false);
  });

  it('reclaims one left behind by a process that is gone', () => {
    // A machine that lost power mid-watch is not a machine that needs a manual
    // rm.
    clearAll();
    liveLock('yan-wait t1', 999_999);
    expect(sup.claimLock()).toBe(true);
    expect(sup.lockTaken()).toBe(true);
  });
});

describe('the beacon', () => {
  it('carries the moment, the pid and what the watcher was doing', () => {
    sup.touchBeacon('subscribed');
    const beacon = readBeacon(sup.beacon);
    expect(beacon?.pid).toBe(process.pid);
    expect(beacon?.task).toBe('t1');
    expect(beacon?.state).toBe('subscribed');
    expect(sup.beaconAgeSeconds()).toBeLessThan(5);
  });

  it("keeps the shell half's three fields readable, with state as a fourth", () => {
    // bin/lib-watch.sh reads fields 1 and 2 by position for as long as both
    // halves are on disk.
    sup.touchBeacon('reconnecting');
    const [at, pid, task, state] = readFileSync(sup.beacon, 'utf8').trim().split(' ');
    expect(/^\d+$/.test(at ?? '')).toBe(true);
    expect(pid).toBe(String(process.pid));
    expect(task).toBe('t1');
    expect(state).toBe('reconnecting');
  });

  it('does not call a clock that went backwards stale', () => {
    writeFileSync(sup.beacon, `${Math.floor(Date.now() / 1000) + 500} ${process.pid} t1 polling\n`);
    expect(sup.beaconAgeSeconds()).toBe(0);
  });

  it('is unreadable rather than wrong when it is half a file', () => {
    writeFileSync(sup.beacon, 'nonsense\n');
    expect(sup.beaconAgeSeconds()).toBeUndefined();
    liveLock();
    expect(sup.healthy()).toBe(false);
  });
});

describe('the wake file', () => {
  it('appends, so two reasons between drains do not erase each other', () => {
    expect(sup.wakeHas('died: s1 - gone')).toBe(false);
    sup.wakeWrite('died: s1 - gone');
    expect(sup.wakeHas('died: s1 - gone')).toBe(true);
    expect(sup.wakeHas('died: s2 - gone')).toBe(false);

    sup.wakeWrite('signal: s2 - reported');
    expect(sup.wakeHas('died: s1 - gone')).toBe(true);
    expect(sup.wakeHas('signal: s2 - reported')).toBe(true);
    expect(readFileSync(sup.wake, 'utf8').split('\n').filter((l) => l !== '')).toHaveLength(2);
  });

  it('matches a whole line, never a fragment of one', () => {
    sup.wakeWrite('blocked: s1 - a question');
    expect(sup.wakeHas('blocked: s1')).toBe(false);
  });
});

describe("the guard's own count", () => {
  it('counts up and starts over', () => {
    expect(sup.guardCount()).toBe(0);
    expect(sup.guardBump()).toBe(1);
    expect(sup.guardBump()).toBe(2);
    expect(sup.guardCount()).toBe(2);
    sup.guardReset();
    expect(sup.guardCount()).toBe(0);
    expect(existsSync(sup.guard)).toBe(false);
  });
});

describe('what is still being supervised', () => {
  it('is derived by scanning, every time it is asked', () => {
    expect(sup.liveCount()).toBe(0);

    liveShift('s1');
    expect(sup.liveCount()).toBe(1);
    expect(sup.liveShifts()[0]?.sid).toBe('s1');
    expect(sup.liveShifts()[0]?.meta().agentId).toBe('w1:p2');

    liveShift('s2', 'w1:p3');
    expect(sup.liveCount()).toBe(2);

    // Clocking out deletes run/ whole, and that IS the fact - nothing mirrors it.
    rmSync(join(home, 'tasks', 't1', 'shifts', 's1', 'run'), { recursive: true, force: true });
    expect(sup.liveCount()).toBe(1);
  });
});
