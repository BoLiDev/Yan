import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { Task } from '../task/index.js';
import { Shift, ShiftError } from './index.js';

/**
 * This module had no test at all. It was written in Phase 1 for callers that
 * arrive in Phase 7, so nothing exercised it and nothing constrained its shape
 * — which is exactly how it ended up with 24 exports of which 3 were used.
 *
 * What is covered here is what exists today: finding a shift, reading its
 * metadata once, and the append that a report is. The Phase 7 behaviours can
 * grow tests with their callers.
 */

let home = '';
let previousHome: string | undefined;
let previousTask: string | undefined;

function seed(task: string, sid: string, meta?: Record<string, unknown>): string {
  Task.create(task, 'a task');
  const run = join(home, 'tasks', task, 'shifts', sid, 'run');
  mkdirSync(run, { recursive: true });
  if (meta !== undefined) writeFileSync(join(run, 'meta.json'), JSON.stringify(meta));
  return run;
}

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  previousTask = process.env.YAN_TASK;
  delete process.env.YAN_TASK;
  home = mkYanHome(mkTempDir());
  process.env.YAN_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
  if (previousTask === undefined) delete process.env.YAN_TASK;
  else process.env.YAN_TASK = previousTask;
});

afterAll(cleanupTempDirs);

describe('finding a shift', () => {
  it('scans for it, because the directory layout IS the registry', () => {
    seed('t042', 's1');
    const shift = Shift.resolve('s1');
    expect(shift.task).toBe('t042');
    expect(shift.sid).toBe('s1');
    expect(shift.label()).toBe('s1 (task t042)');
  });

  it('refuses an id that exists under two tasks rather than guessing', () => {
    seed('t042', 's1');
    seed('t043', 's1');
    let thrown: unknown;
    try {
      Shift.resolve('s1');
    } catch (e) {
      thrown = e;
    }
    expect((thrown as ShiftError).code).toBe(ShiftError.codes.ambiguous);
    expect((thrown as Error).message).toContain('more than one task');

    // …and naming the task resolves it.
    expect(Shift.resolve('s1', 't043').task).toBe('t043');
  });

  it('narrows the search with $YAN_TASK, which is the normal case', () => {
    seed('t042', 's1');
    seed('t043', 's1');
    process.env.YAN_TASK = 't042';
    expect(Shift.resolve('s1').task).toBe('t042');
  });

  it('says so when there is nothing to find', () => {
    expect(() => Shift.resolve('nope')).toThrow(/no such shift/);
    expect(() => Shift.resolve('')).toThrow(ShiftError);
  });

  it('recovers the task from a directory only when the layout says so', () => {
    const run = seed('t042', 's1');
    expect(Shift.fromDir(join(run, '..')).task).toBe('t042');

    // Anywhere else it stays empty: guessing would be worse than not knowing.
    const loose = mkTempDir();
    mkdirSync(join(loose, 's9'), { recursive: true });
    const shift = Shift.fromDir(join(loose, 's9'));
    expect(shift.task).toBe('');
    expect(shift.label()).toBe('s9');
  });
});

describe('run/meta.json is read once, and defensively', () => {
  it('answers "I do not know" for anything it cannot read', () => {
    seed('t042', 's1');
    expect(Shift.resolve('s1').meta()).toEqual({});

    seed('t043', 's2', { unit: 'auth' } as Record<string, unknown>);
    writeFileSync(join(home, 'tasks', 't043', 'shifts', 's2', 'run', 'meta.json'), '{ half');
    expect(Shift.resolve('s2', 't043').meta()).toEqual({});
  });

  it('accepts either spelling of the terminal id, and reports absence as absence', () => {
    seed('t042', 's1', { unit: 'auth', tree: '/trees/1/demo', pane_id: 'w1:p2' });
    const meta = Shift.resolve('s1').meta();
    expect(meta.unit).toBe('auth');
    expect(meta.tree).toBe('/trees/1/demo');
    expect(meta.agentId).toBe('w1:p2');
    // Not present, and not present as a key either.
    expect('branch' in meta).toBe(false);
  });
});

describe('reporting', () => {
  it('writes the event and then the wake marker, in that order', () => {
    const run = seed('t042', 's1');
    const shift = Shift.resolve('s1');
    shift.appendEvent('done', 'mr https://example.invalid/mr/31');

    const line = readFileSync(join(run, 'status'), 'utf8').trim();
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:]{8}Z\tdone\tmr https:/);
    expect(existsSync(join(run, 'signal'))).toBe(true);
    expect(shift.eventCount()).toBe(1);
    expect(shift.reportedMr()).toBe('https://example.invalid/mr/31');
  });

  it('appends rather than replacing, so an earlier event is never lost', () => {
    const run = seed('t042', 's1');
    const shift = Shift.resolve('s1');
    shift.appendEvent('working', 'first');
    shift.appendEvent('blocked', 'second');

    const lines = readFileSync(join(run, 'status'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('first');
    expect(lines[1]).toContain('second');
    expect(shift.eventCount()).toBe(2);
    // The marker survives the second report; it is touched, not recreated.
    expect(existsSync(join(run, 'signal'))).toBe(true);
  });

  it('refuses a newline, which would forge a second event', () => {
    seed('t042', 's1');
    const shift = Shift.resolve('s1');
    expect(() => shift.appendEvent('done', 'one\ntwo')).toThrow(/one line/);
    expect(() => shift.appendEvent('')).toThrow(/needs a state/);
  });

  it('offers no way to read the last line', () => {
    // Every line is an event, not the current state. A
    // `last()` would be read as "the state" within a week, so it does not exist
    // and this is the alarm if it ever does.
    const surface = Object.getOwnPropertyNames(Shift.prototype);
    for (const forbidden of ['last', 'lastEvent', 'state', 'status', 'currentState']) {
      expect(surface).not.toContain(forbidden);
    }
    expect(surface).toContain('eventCount');
  });
});

describe('liveIn', () => {
  it('counts a shift live while run/meta.json is there', () => {
    seed('t042', 's1', { unit: 'auth' });
    seed('t042', 's2');
    expect(Shift.liveIn('t042').map((s) => s.sid)).toEqual(['s1']);
    expect(Shift.resolve('s1').isLive()).toBe(true);
  });
});
