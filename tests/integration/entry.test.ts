import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';

/**
 * Bare `yan` (cli-ux.md §2).
 *
 * | `yan` with a TTY    | the select                                 |
 * | `yan` without a TTY | usage, exit 0 — unchanged, so scripts and agents see no difference |
 *
 * Clack needs a real terminal and a test runner has none, so what is exercised
 * here is the half a test CAN see: the no-TTY behaviour, and the ROWS the
 * select is built from. Those rows are the interesting claim — "derived, never
 * stored, from the same scan `yan ls` uses" — and getting them wrong is how a
 * menu starts disagreeing with the directory.
 */

afterAll(cleanupTempDirs);

let home = '';

beforeAll(async () => {
  home = mkYanHome(join(mkTempDir(), 'home'), { withDist: true });
  mkdirSync(join(home, 'repos', 'demo'), { recursive: true });

  const previous = process.env.YAN_HOME;
  process.env.YAN_HOME = home;
  const { Task } = await import('../../src/records/task/index.js');
  Task.create('t001', 'unify the auth header');
  new Task('t001').addUnit('auth', 'demo', 'main', { branch: 'feat/auth' });
  Task.create('t002', 'gateway retry budget');
  Task.create('t003', 'finished ages ago');
  new Task('t003').setComplete(true);
  if (previous === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previous;

  // One live shift on t001, which is what the hint counts. `run/` existing IS
  // the fact that a shift is live, so that is all this has to write.
  mkdirSync(join(home, 'tasks', 't001', 'shifts', 's1', 'run'), { recursive: true });
  writeFileSync(
    join(home, 'tasks', 't001', 'shifts', 's1', 'run', 'meta.json'),
    `${JSON.stringify({ version: 1, task: 't001', sid: 's1', unit: 'auth' })}\n`,
  );
});

describe('without a TTY', () => {
  it('prints usage and exits 0: it is not an unknown command, so it is not an error', async () => {
    const r = await runYan(home, []);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('Usage: yan');
    expect(r.stdout).toContain('continue');
    expect(r.stdout).toContain('task');
  });
});

describe('the rows the select offers', () => {
  it('are create-new-task plus the live tasks, from `yan ls`\'s own scan', async () => {
    const previous = process.env.YAN_HOME;
    process.env.YAN_HOME = home;
    try {
      const { liveTaskChoices } = await import('../../src/cli/yan.js');
      const rows = liveTaskChoices();
      // t003 is complete, so it is not something to continue.
      expect(rows.map((r) => r.id)).toEqual(['t001', 't002']);
      expect(rows[0]).toEqual({ id: 't001', title: 'unify the auth header', units: 1, shifts: 1 });
      expect(rows[1]?.shifts).toBe(0);

      // …and they really are the same numbers `yan ls --json` reports, rather
      // than a second count that can drift from it.
      const ls = JSON.parse((await runYan(home, ['ls', '--json'])).stdout) as {
        tasks: { id: string; shifts: number }[];
      };
      expect(ls.tasks.find((t) => t.id === 't001')?.shifts).toBe(rows[0]?.shifts);
    } finally {
      if (previous === undefined) delete process.env.YAN_HOME;
      else process.env.YAN_HOME = previous;
    }
  });
});
