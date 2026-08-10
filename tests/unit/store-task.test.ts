import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as t from '../../src/store/task.js';
import { YanError } from '../../src/util/error.js';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../helpers/fixtures.js';

/**
 * The port of `tests/unit/lib-task.test.sh`.
 *
 * Phase 1 Trace: "history[] stays append-only; the four current scalars stay
 * separate from it."
 */

let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir());
  process.env.YAN_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

afterAll(cleanupTempDirs);

function seed(): void {
  t.taskInit('t042', 'unify the auth header');
  t.unitAdd('t042', 'auth', 'monorepo-x', 'master', {
    branch: 'feat/auth-r1',
    scope: ['apps/auth', 'apps/common'],
  });
}

describe('creation', () => {
  it('makes task.json, brief.md and log.md, and is idempotent', () => {
    t.taskInit('t042', 'unify the auth header');
    const dir = t.taskDir('t042');
    expect(readFileSync(join(dir, 'brief.md'), 'utf8')).toContain('# t042 unify the auth header');
    expect(readFileSync(join(dir, 'log.md'), 'utf8')).toBe('# t042 unify the auth header\n\n');

    t.taskInit('t042', 'a different title');
    expect(t.taskTitle('t042')).toBe('unify the auth header');
  });

  it('refuses a bad task id', () => {
    expect(() => t.taskInit('', 'x')).toThrow(YanError);
    expect(() => t.taskInit('has space', 'x')).toThrow(YanError);
    expect(() => t.taskInit('t042/../escape', 'x')).toThrow(YanError);
  });

  it('lists tasks by scanning, never from a stored list', () => {
    t.taskInit('t002', 'second');
    t.taskInit('t001', 'first');
    expect(t.taskList()).toEqual(['t001', 't002']);
  });
});

describe('units', () => {
  it('requires an explicit target and defaults mode to mr', () => {
    t.taskInit('t042', 'x');
    expect(() => t.unitAdd('t042', 'auth', 'monorepo-x', '')).toThrow(YanError);
    t.unitAdd('t042', 'auth', 'monorepo-x', 'master');
    expect(t.requireUnit(t.readTask('t042'), 'auth').mode).toBe('mr');
  });

  it('refuses a duplicate unit and an invalid mode', () => {
    seed();
    expect(() => t.unitAdd('t042', 'auth', 'monorepo-x', 'master')).toThrow(YanError);
    expect(() => t.unitAdd('t042', 'other', 'monorepo-x', 'master', { mode: 'nope' })).toThrow(
      YanError,
    );
  });

  it('writes the unit shape branching.md §6.4 specifies, in that key order', () => {
    seed();
    const raw = JSON.parse(readFileSync(t.taskFile('t042'), 'utf8')) as {
      units: Record<string, unknown>[];
    };
    expect(Object.keys(raw.units[0] as object)).toEqual([
      'name',
      'repo',
      'scope',
      'needs',
      'branch',
      'target',
      'mode',
      'mr',
      'history',
    ]);
  });
});

describe('the four current scalars', () => {
  it('are set without ever touching history[]', () => {
    seed();
    t.unitSet('t042', 'auth', 'branch', 'feat/auth-r2');
    t.unitSet('t042', 'auth', 'mr', 'https://example.invalid/mr/31');
    t.unitSet('t042', 'auth', 'mode', 'branch');

    const unit = t.requireUnit(t.readTask('t042'), 'auth');
    expect(unit.branch).toBe('feat/auth-r2');
    expect(unit.mr).toBe('https://example.invalid/mr/31');
    expect(unit.mode).toBe('branch');
    expect(unit.history).toEqual([]);
  });

  it('refuses an invalid mode', () => {
    seed();
    expect(() => t.unitSet('t042', 'auth', 'mode', 'nope')).toThrow(YanError);
  });

  it('refuses an unknown unit', () => {
    seed();
    expect(() => t.unitSet('t042', 'nope', 'branch', 'x')).toThrow(YanError);
  });
});

describe('history is append-only', () => {
  it('offers no way to reach an existing entry', () => {
    // The API is the enforcement. If one of these ever appears, invariant 1 has
    // been lost and this test is the alarm.
    const surface = Object.keys(t);
    for (const forbidden of ['historySet', 'historyReplace', 'historyDelete', 'historyAt']) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('carries every earlier entry across untouched', () => {
    seed();
    t.historyAppend('t042', 'auth', 'feat/auth-r1', 'master', '08-01', 'delivered', 'mr/1');
    t.historyAppend('t042', 'auth', 'feat/auth-r2', 'master', '08-05', 'abandoned');

    const history = t.requireUnit(t.readTask('t042'), 'auth').history;
    expect(history).toEqual([
      { branch: 'feat/auth-r1', target: 'master', at: '08-01', end: 'delivered', mr: 'mr/1' },
      { branch: 'feat/auth-r2', target: 'master', at: '08-05', end: 'abandoned' },
    ]);
    expect(t.unitRounds('t042', 'auth')).toBe(2);
  });

  it('refuses an end that is not delivered or abandoned', () => {
    seed();
    expect(() => t.historyAppend('t042', 'auth', 'b', 'master', '', 'finished')).toThrow(YanError);
  });

  it('rotate archives the round and clears mr, atomically', () => {
    seed();
    t.unitSet('t042', 'auth', 'mr', 'https://example.invalid/mr/31');
    t.unitRotate('t042', 'auth', 'delivered', 'feat/auth-r2', '08-09');

    const unit = t.requireUnit(t.readTask('t042'), 'auth');
    expect(unit.branch).toBe('feat/auth-r2');
    expect(unit.mr).toBeNull();
    expect(unit.history).toEqual([
      {
        branch: 'feat/auth-r1',
        target: 'master',
        at: '08-09',
        end: 'delivered',
        mr: 'https://example.invalid/mr/31',
      },
    ]);
  });
});

describe('the completion flag', () => {
  it('is the one thing about a task that is stored rather than derived', () => {
    seed();
    expect(t.taskIsComplete('t042')).toBe(false);
    t.setComplete('t042', true);
    expect(t.taskIsComplete('t042')).toBe(true);
  });
});

describe('reading is defensive', () => {
  it('survives a task.json missing every optional key', () => {
    t.taskInit('t042', 'x');
    writeFileSync(t.taskFile('t042'), '{"version":1}\n');
    const task = t.readTask('t042');
    expect(task.title).toBe('');
    expect(task.units).toEqual([]);
    expect(task.complete).toBe(false);
  });

  it('reports a genuinely missing task rather than inventing one', () => {
    expect(() => t.readTask('nope')).toThrow(YanError);
    expect(t.taskExists('nope')).toBe(false);
  });
});
