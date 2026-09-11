import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bashCommand, cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';

/** `yan log`: the one way yan writes an entry no command wrote for it. */

afterAll(cleanupTempDirs);

let home = '';

function log(): string {
  return readFileSync(join(home, 'tasks', 't042', 'log.md'), 'utf8');
}

beforeAll(async () => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  const previous = process.env.YAN_HOME;
  process.env.YAN_HOME = home;
  const { Task } = await import('../../src/records/task/index.js');
  Task.create('t042', 'unify the auth header');
  if (previous === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previous;
});

describe('yan log', () => {
  it('appends one typed, dated entry to the task in $YAN_TASK', async () => {
    const r = await runYan(home, ['log', 'agreed', 'user chose copy-at-creation over live inheritance'], { YAN_TASK: 't042' });
    expect(r.code, r.out).toBe(0);
    expect(log()).toMatch(/\n- \d{2}-\d{2} {2}agreed {5}user chose copy-at-creation over live inheritance\n$/);
  });

  it('takes --task over the environment', async () => {
    const r = await runYan(home, ['log', 'paused', 'user is away; s3 still running', '--task', 't042'], { YAN_TASK: '' });
    expect(r.code, r.out).toBe(0);
    expect(log()).toContain('paused     user is away; s3 still running');
  });

  it('refuses a type it does not know, and names the six', async () => {
    const before = log();
    const r = await runYan(home, ['log', 'decided', 'x'], { YAN_TASK: 't042' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('agreed started delivered changed incident paused');
    expect(log()).toBe(before);
  });

  it('refuses no entry, no task, and a task that does not exist', async () => {
    expect((await runYan(home, ['log', 'agreed'], { YAN_TASK: 't042' })).code).toBe(2);
    expect((await runYan(home, ['log', 'agreed', 'x'], { YAN_TASK: '' })).code).toBe(2);
    expect((await runYan(home, ['log', 'agreed', 'x', '--task', 't404'])).code).toBe(2);
  });

  it('refuses an entry on more than one line', () => {
    const before = log();
    // Built inside bash: on Windows a literal newline in argv is re-split
    // before it reaches the process.
    const r = spawnSync(
      bashCommand(),
      ['-c', `bash "$1" log agreed $'one\ntwo' --task t042`, '_', join(home, 'bin', 'yan')],
      { encoding: 'utf8', env: { ...process.env, YAN_HOME: home }, windowsHide: true },
    );
    expect(r.status).toBe(2);
    expect(log()).toBe(before);
  });
});
