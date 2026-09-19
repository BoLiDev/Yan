import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Task } from './index.js';
import type { TaskData, UnitData } from './index.js';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { YanError } from '../../util/error.js';

/**
 * The two claims under test: history[] only ever grows, and the current
 * branch, target and mr stay separate from it.
 */

/** One unit out of an already-parsed document. A test accessor only. */
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
    expect(() => Task.create('', 'x')).toThrow(YanError);
    expect(() => Task.create('has space', 'x')).toThrow(YanError);
    expect(() => Task.create('t042/../escape', 'x')).toThrow(YanError);
  });

  it('lists tasks by scanning, never from a stored list', () => {
    Task.create('t002', 'second');
    Task.create('t001', 'first');
    expect(Task.list()).toEqual(['t001', 't002']);
  });
});

describe('units', () => {
  it('requires an explicit target', () => {
    Task.create('t042', 'x');
    expect(() => new Task('t042').addUnit('auth', 'monorepo-x', '')).toThrow(YanError);
    new Task('t042').addUnit('auth', 'monorepo-x', 'master');
    expect(requireUnitOf(new Task('t042').read(), 'auth').target).toBe('master');
  });

  it('refuses a duplicate unit', () => {
    seed();
    expect(() => new Task('t042').addUnit('auth', 'monorepo-x', 'master')).toThrow(YanError);
  });

  it('reads a task.json an older yan wrote, mode and all, and leaves the field alone', () => {
    // A unit used to carry a `mode`; what a shift delivers is its scenario's
    // now. A vault shared with a machine still on the older yan keeps such
    // files around, and they must neither refuse to load nor be rewritten.
    seed();
    const file = new Task('t042').file;
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { units: Record<string, unknown>[] };
    raw.units[0]!.mode = 'scout';
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);

    const unit = requireUnitOf(new Task('t042').read(), 'auth');
    expect(unit.branch).toBe('feat/auth-r1');
    new Task('t042').editUnit('auth', (u) => {
      u.mr = 'https://example.invalid/mr/7';
    });
    const after = JSON.parse(readFileSync(file, 'utf8')) as { units: Record<string, unknown>[] };
    expect(after.units[0]!.mode).toBe('scout');
  });

  it('writes the unit fields in a fixed key order', () => {
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
      'mr',
      'history',
    ]);
  });
});

describe('the three current scalars', () => {
  it('are set without ever touching history[]', () => {
    seed();
    new Task('t042').editUnit('auth', (u) => {
      u.branch = 'feat/auth-r2';
      u.mr = 'https://example.invalid/mr/31';
    });

    const unit = requireUnitOf(new Task('t042').read(), 'auth');
    expect(unit.branch).toBe('feat/auth-r2');
    expect(unit.mr).toBe('https://example.invalid/mr/31');
    expect(unit.history).toEqual([]);
  });

  it('refuses an unknown unit', () => {
    seed();
    expect(() => new Task('t042').editUnit('nope', (u) => {
      u.branch = 'x';
    })).toThrow(YanError);
  });
});

describe('history only ever grows', () => {
  it('offers no way to reach an existing entry', () => {
    // Rotating is the only thing on the record that writes history[], and it
    // appends. The absence of these is what keeps it that way.
    const surface = Object.getOwnPropertyNames(Task.prototype);
    for (const forbidden of ['setHistory', 'replaceHistory', 'deleteHistory', 'historyAt']) {
      expect(surface).not.toContain(forbidden);
    }
    expect(surface).toContain('rotateUnit');
  });

  it('carries every earlier entry across untouched', () => {
    seed();
    new Task('t042').editUnit('auth', (u) => {
      u.mr = 'mr/1';
    });
    new Task('t042').rotateUnit('auth', 'delivered', 'feat/auth-r2', '08-01');
    new Task('t042').rotateUnit('auth', 'abandoned', 'feat/auth-r3', '08-05');

    const history = requireUnitOf(new Task('t042').read(), 'auth').history;
    expect(history).toEqual([
      { branch: 'feat/auth-r1', target: 'master', at: '08-01', end: 'delivered', mr: 'mr/1' },
      { branch: 'feat/auth-r2', target: 'master', at: '08-05', end: 'abandoned' },
    ]);
  });

  it('refuses an end that is not one of ENDS', () => {
    seed();
    expect(() => new Task('t042').rotateUnit('auth', 'finished', 'feat/auth-r2')).toThrow(YanError);
  });

  it('rotate archives the round and clears mr, atomically', () => {
    seed();
    new Task('t042').editUnit('auth', (u) => {
      u.mr = 'https://example.invalid/mr/31';
    });
    new Task('t042').rotateUnit('auth', 'delivered', 'feat/auth-r2', '08-09');

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
    expect(() => new Task('nope').read()).toThrow(YanError);
    expect(Task.exists('nope')).toBe(false);
  });
});

describe('createdAt and closedAt', () => {
  const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

  it('stamps createdAt at creation, to the second, in UTC, and keeps version 1', () => {
    Task.create('t042', 'unify the auth header');
    const data = new Task('t042').read();
    expect(data.createdAt).toMatch(ISO);
    expect(Math.abs(Date.parse(data.createdAt ?? '') - Date.now())).toBeLessThan(5000);
    expect(data.closedAt).toBeUndefined();
    expect(data.version).toBe(1);
  });

  it('stamps closedAt when the task is marked done or abandoned, and drops it when reopened', () => {
    Task.create('t042', 'unify the auth header');
    const task = new Task('t042');
    task.setComplete(true);
    expect(task.read().closedAt).toMatch(ISO);
    task.setComplete(false);
    expect(task.read().closedAt).toBeUndefined();
    expect(JSON.parse(readFileSync(task.file, 'utf8'))).not.toHaveProperty('closedAt');
    task.setAbandoned();
    expect(task.read().closedAt).toMatch(ISO);
  });

  it('still reads a task.json from before the fields existed', () => {
    Task.create('t042', 'unify the auth header');
    const task = new Task('t042');
    writeFileSync(task.file, JSON.stringify({ version: 1, id: 't042', title: 'old', complete: true, units: [] }));
    const data = task.read();
    expect(data.createdAt).toBeUndefined();
    expect(data.closedAt).toBeUndefined();
    expect(data.complete).toBe(true);
  });
});
