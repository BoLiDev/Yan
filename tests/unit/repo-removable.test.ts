import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, registerRepo } from '../helpers/fixtures.js';
import { removable } from '../../src/cli/repo.js';
import { Task } from '../../src/records/task/index.js';

/**
 * `yan repo rm`'s list.
 *
 * Not the interactive half, which needs a terminal: which repositories are
 * offered, and what is said about the ones that cannot be taken.
 */

afterAll(cleanupTempDirs);

let home = '';

beforeAll(() => {
  const tmp = mkTempDir('yan-removable-');
  home = mkYanHome(join(tmp, 'home'), {});
  const code = join(tmp, 'code');
  mkdirSync(join(code, 'free'), { recursive: true });
  mkdirSync(join(code, 'held'), { recursive: true });
  mkdirSync(join(code, 'finished'), { recursive: true });

  registerRepo(home, 'free', join(code, 'free'), { url: 'git@host:org/free.git' });
  registerRepo(home, 'held', join(code, 'held'), { url: 'git@host:org/held.git' });
  registerRepo(home, 'finished', join(code, 'finished'), { url: 'git@host:org/finished.git' });

  // A vault that arrived from another machine: registered, with no path here.
  const file = join(home, 'repos.json');
  const reg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  reg.elsewhere = { url: 'git@host:org/elsewhere.git', pool_size: 8 };
  writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`);

  Task.create('t001', 'still going');
  new Task('t001').addUnit('held', 'held', 'main', {});
  Task.create('t002', 'long over');
  new Task('t002').addUnit('finished', 'finished', 'main', {});
  new Task('t002').edit((t) => {
    t.complete = true;
  });
});

describe('everything registered, and everything visible', () => {
  it('offers every registered repository, linked here or not', () => {
    const rows = removable();
    expect(rows.map((r) => r.name)).toEqual(['elsewhere', 'finished', 'free', 'held']);
    expect(rows.find((r) => r.name === 'elsewhere')?.path).toBe('');
    expect(rows.find((r) => r.name === 'free')?.path).toContain('code/free');
  });

  it('lists one an open task holds, disabled, naming the task', () => {
    const held = removable().find((r) => r.name === 'held');
    expect(held, 'silently leaving it out would look like a bug in the list').toBeDefined();
    expect(held?.blocked).toContain('t001');
  });

  it('does not hold one back over a task that is finished', () => {
    expect(removable().find((r) => r.name === 'finished')?.blocked).toBe('');
    expect(removable().find((r) => r.name === 'free')?.blocked).toBe('');
  });
});
