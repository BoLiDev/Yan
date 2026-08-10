import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Task, TaskError, Unit } from './index.js';
import type { TaskData, UnitData } from './index.js';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';

/**
 * The port of `tests/unit/lib-task.test.sh`.
 *
 * Phase 1 Trace: "history[] stays append-only; the four current scalars stay
 * separate from it."
 */

/**
 * The unit data a fixture just wrote. A test accessor, not module surface:
 * `Task.unit(name)` hands back identity, and `.read()` is how you get data —
 * pulling a unit out of an already-parsed document is a convenience only a
 * test wants.
 */
function requireUnitOf(task: TaskData, name: string): UnitData {
  const found = task.units.find((u) => u.name === name);
  if (found === undefined) throw new Error(`no such unit in the fixture: `);
  return found;
}

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
  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'monorepo-x', 'master', {
    branch: 'feat/auth-r1',
    scope: ['apps/auth', 'apps/common'],
  });
}

describe('creation', () => {
  it('makes task.json, brief.md and log.md, and is idempotent', () => {
    Task.create('t042', 'unify the auth header');
    const dir = new Task('t042').dir;
    expect(readFileSync(join(dir, 'brief.md'), 'utf8')).toContain('# t042 unify the auth header');
    expect(readFileSync(join(dir, 'log.md'), 'utf8')).toBe('# t042 unify the auth header\n\n');

    Task.create('t042', 'a different title');
    expect(new Task('t042').title()).toBe('unify the auth header');
  });

  it('refuses a bad task id', () => {
    expect(() => Task.create('', 'x')).toThrow(TaskError);
    expect(() => Task.create('has space', 'x')).toThrow(TaskError);
    expect(() => Task.create('t042/../escape', 'x')).toThrow(TaskError);
  });

  it('lists tasks by scanning, never from a stored list', () => {
    Task.create('t002', 'second');
    Task.create('t001', 'first');
    expect(Task.list()).toEqual(['t001', 't002']);
  });
});

describe('units', () => {
  it('requires an explicit target and defaults mode to mr', () => {
    Task.create('t042', 'x');
    expect(() => new Task('t042').addUnit('auth', 'monorepo-x', '')).toThrow(TaskError);
    new Task('t042').addUnit('auth', 'monorepo-x', 'master');
    expect(requireUnitOf(new Task('t042').read(), 'auth').mode).toBe('mr');
  });

  it('refuses a duplicate unit and an invalid mode', () => {
    seed();
    expect(() => new Task('t042').addUnit('auth', 'monorepo-x', 'master')).toThrow(TaskError);
    expect(() => new Task('t042').addUnit('other', 'monorepo-x', 'master', { mode: 'nope' })).toThrow(
      TaskError,
    );
  });

  it('writes the unit shape branching.md §6.4 specifies, in that key order', () => {
    seed();
    const raw = JSON.parse(readFileSync(new Task('t042').file, 'utf8')) as {
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
    new Task('t042').unit('auth').set('branch', 'feat/auth-r2');
    new Task('t042').unit('auth').set('mr', 'https://example.invalid/mr/31');
    new Task('t042').unit('auth').set('mode', 'branch');

    const unit = requireUnitOf(new Task('t042').read(), 'auth');
    expect(unit.branch).toBe('feat/auth-r2');
    expect(unit.mr).toBe('https://example.invalid/mr/31');
    expect(unit.mode).toBe('branch');
    expect(unit.history).toEqual([]);
  });

  it('refuses an invalid mode', () => {
    seed();
    expect(() => new Task('t042').unit('auth').set('mode', 'nope')).toThrow(TaskError);
  });

  it('refuses an unknown unit', () => {
    seed();
    expect(() => new Task('t042').unit('nope').set('branch', 'x')).toThrow(TaskError);
  });
});

describe('history is append-only', () => {
  it('offers no way to reach an existing entry', () => {
    // The API is the enforcement. If one of these ever appears, invariant 1 has
    // been lost and this test is the alarm.
    const surface = Object.getOwnPropertyNames(Unit.prototype);
    for (const forbidden of ['setHistory', 'replaceHistory', 'deleteHistory', 'historyAt']) {
      expect(surface).not.toContain(forbidden);
    }
    // The only writer is an append, and it takes no index.
    expect(surface).toContain('appendHistory');
  });

  it('carries every earlier entry across untouched', () => {
    seed();
    new Task('t042').unit('auth').appendHistory('feat/auth-r1', 'master', '08-01', 'delivered', 'mr/1');
    new Task('t042').unit('auth').appendHistory('feat/auth-r2', 'master', '08-05', 'abandoned');

    const history = requireUnitOf(new Task('t042').read(), 'auth').history;
    expect(history).toEqual([
      { branch: 'feat/auth-r1', target: 'master', at: '08-01', end: 'delivered', mr: 'mr/1' },
      { branch: 'feat/auth-r2', target: 'master', at: '08-05', end: 'abandoned' },
    ]);
    expect(new Task('t042').unit('auth').rounds()).toBe(2);
  });

  it('refuses an end that is not delivered or abandoned', () => {
    seed();
    expect(() => new Task('t042').unit('auth').appendHistory('b', 'master', '', 'finished')).toThrow(TaskError);
  });

  it('rotate archives the round and clears mr, atomically', () => {
    seed();
    new Task('t042').unit('auth').set('mr', 'https://example.invalid/mr/31');
    new Task('t042').unit('auth').rotate('delivered', 'feat/auth-r2', '08-09');

    const unit = requireUnitOf(new Task('t042').read(), 'auth');
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
    expect(new Task('t042').isComplete()).toBe(false);
    new Task('t042').setComplete(true);
    expect(new Task('t042').isComplete()).toBe(true);
  });
});

describe('reading is defensive', () => {
  it('survives a task.json missing every optional key', () => {
    Task.create('t042', 'x');
    writeFileSync(new Task('t042').file, '{"version":1}\n');
    const task = new Task('t042').read();
    expect(task.title).toBe('');
    expect(task.units).toEqual([]);
    expect(task.complete).toBe(false);
  });

  it('reports a genuinely missing task rather than inventing one', () => {
    expect(() => new Task('nope').read()).toThrow(TaskError);
    expect(Task.exists('nope')).toBe(false);
  });
});
