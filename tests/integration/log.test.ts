import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bashCommand, cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { Task } from '../../src/records/task/index.js';

/** `yan log`: the one way yan writes an entry no command wrote for it. */

afterAll(cleanupTempDirs);

let home = '';

function log(): string {
  return readFileSync(join(home, 'tasks', 't042', 'log.md'), 'utf8');
}

beforeAll(() => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  Task.create('t042', 'unify the auth header');
});

describe('yan log', () => {
  it('appends one typed, dated entry to the task in $YAN_TASK', async () => {
    const r = await runYan(home, ['log', 'agreed', 'user chose copy-at-creation over live inheritance'], { YAN_TASK: 't042' });
    expect(r.code, r.out).toBe(0);
    expect(log()).toMatch(/\n- \d{2}-\d{2} {2}agreed {5}user chose copy-at-creation over live inheritance\n$/);
  });

  it('refuses a type it does not know, and names the six', async () => {
    const before = log();
    const r = await runYan(home, ['log', 'decided', 'x'], { YAN_TASK: 't042' });
    expectUsage(r, 'agreed started delivered changed incident paused');
    expect(log()).toBe(before);
  });

  it('refuses no entry, no task, and a task that does not exist', async () => {
    expectUsage(await runYan(home, ['log', 'agreed'], { YAN_TASK: 't042' }), 'the entry is required');
    expectUsage(await runYan(home, ['log', 'agreed', 'x'], { YAN_TASK: '' }), '$YAN_TASK is unset');
    expectUsage(await runYan(home, ['log', 'agreed', 'x'], { YAN_TASK: 't404' }), 'no such task');
  });

  it('refuses an entry on more than one line', () => {
    const before = log();
    // Built inside bash: on Windows a literal newline in argv is re-split
    // before it reaches the process.
    const r = spawnSync(
      bashCommand(),
      ['-c', `bash "$1" log agreed $'one\ntwo'`, '_', join(home, 'bin', 'yan')],
      {
        encoding: 'utf8',
        env: { ...process.env, YAN_HOME: home, YAN_VAULT: home, YAN_MACHINE_DIR: join(home, '.machine'), YAN_TASK: 't042' },
        windowsHide: true,
      },
    );
    expectUsage({ code: r.status ?? 1, out: `${r.stdout}${r.stderr}` }, 'one line');
    expect(log()).toBe(before);
  });
});
