import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { bashCommand, cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';

/**
 * `yan report`.
 *
 * It accepts only the five allowed states, and it appends `run/status` and
 * touches `run/signal` in one go. "In one go" is the reason the command exists
 * at all — do not count on an agent remembering step two — so it
 * is asserted the only way that means anything: one invocation, then both
 * effects checked.
 */

afterAll(cleanupTempDirs);

let home = '';
let run = '';

function lines(file: string): number {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').length;
}

function status(): string {
  return existsSync(join(run, 'status')) ? readFileSync(join(run, 'status'), 'utf8') : '';
}

beforeAll(async () => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  const previous = process.env.YAN_HOME;
  process.env.YAN_HOME = home;
  const { Task } = await import('../../src/records/task/index.js');
  Task.create('t042', 'unify the auth header');
  new Task('t042').addUnit('auth', 'monorepo-x', 'master', { branch: 'feat/auth', scope: ['apps/auth'] });
  Task.create('t007', 'retire the legacy client');
  if (previous === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previous;

  run = join(home, 'tasks', 't042', 'shifts', 's1', 'run');
  mkdirSync(join(home, 'tasks', 't042', 'shifts', 's1'), { recursive: true });
  mkdirSync(join(home, 'tasks', 't007', 'shifts', 's1'), { recursive: true });
});

describe('one command, both effects', () => {
  it('appends the event and touches the wake marker', async () => {
    expect(existsSync(join(run, 'status'))).toBe(false);

    const r = await runYan(home, ['report', 'done', 'mr https://forge.invalid/x/-/merge_requests/1', '--sid', 's1', '--task', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(run, 'status')), 'the event was appended').toBe(true);
    expect(existsSync(join(run, 'signal')), 'the wake marker was touched by the same command').toBe(true);
    expect(lines(join(run, 'status'))).toBe(1);

    const first = status().split('\n')[0] ?? '';
    expect(first, 'the state is its own field').toContain('\tdone\t');
    expect(first, 'the note is kept verbatim').toContain('merge_requests/1');
    expect(first).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/);
  });

  it('re-touches the wake marker on every report, not only the first', async () => {
    rmSync(join(run, 'signal'));
    const r = await runYan(home, ['report', 'blocked', 'waiting for a credential', '--sid', 's1', '--task', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(existsSync(join(run, 'signal')), 'signal is written again on the next report').toBe(true);
    expect(lines(join(run, 'status')), 'run/status is appended, never replaced').toBe(2);
    expect(status(), 'the earlier event survived').toContain('merge_requests/1');
  });
});

describe('exactly five states', () => {
  it('accepts the other three', async () => {
    for (const state of ['started', 'needs-decision', 'conflict']) {
      const r = await runYan(home, ['report', state, `note for ${state}`, '--sid', 's1', '--task', 't042']);
      expect(r.code, `${state} must be accepted: ${r.out}`).toBe(0);
    }
    expect(lines(join(run, 'status')), 'all five allowed states were accepted').toBe(5);
  });

  it('refuses a sixth word loudly, and writes nothing at all', async () => {
    const before = status();
    for (const bad of ['progress', 'DONE', 'finished', 'failed', 'stuck', 'note', '']) {
      const r = await runYan(home, ['report', bad, 'a note', '--sid', 's1', '--task', 't042']);
      expect(r.code, `'${bad}' is not one of the five and must be refused loudly`).toBe(2);
      expect(r.out, 'the refusal names the whole allowed set').toContain('started done blocked needs-decision conflict');
    }
    expect(status(), 'a refused state writes nothing at all').toBe(before);
  });
});

describe('a note is required, and it is one line', () => {
  it('refuses a state with no note, and a note with a newline in it', async () => {
    const before = status();
    expect((await runYan(home, ['report', 'done', '--sid', 's1', '--task', 't042'])).code).toBe(2);

    // The newline is built inside bash rather than passed through spawnSync's
    // argv: on Windows a literal newline in an argument is re-split before it
    // reaches the process, which would test the harness and not the command.
    const r = spawnSync(
      bashCommand(),
      ['-c', `bash "$1" report done $'two\\nlines' --sid s1 --task t042`, '_', join(home, 'bin', 'yan')],
      { encoding: 'utf8', env: { ...process.env, YAN_HOME: home }, windowsHide: true },
    );
    expect(r.status, 'a newline would forge a second event').toBe(2);
    expect(`${r.stdout ?? ''}${r.stderr ?? ''}`).toContain('one line');
    expect(status()).toBe(before);
  });
});

describe('who is reporting: the spawn environment, not an argument', () => {
  it('reads all three spellings', async () => {
    const shiftDir = join(home, 'tasks', 't042', 'shifts', 's1');
    expect((await runYan(home, ['report', 'done', 'via YAN_SHIFT_DIR'], { YAN_SHIFT_DIR: shiftDir })).code).toBe(0);
    expect(lines(join(run, 'status'))).toBe(6);

    expect((await runYan(home, ['report', 'done', 'via YAN_TASK_DIR as the shift dir'], { YAN_TASK_DIR: shiftDir })).code).toBe(0);
    expect(
      (await runYan(home, ['report', 'done', 'via YAN_TASK_DIR plus YAN_SID'], {
        YAN_TASK_DIR: join(home, 'tasks', 't042'),
        YAN_SID: 's1',
      })).code,
    ).toBe(0);
    expect((await runYan(home, ['report', 'done', 'via ids only'], { YAN_TASK: 't042', YAN_SID: 's1' })).code).toBe(0);
    expect(lines(join(run, 'status'))).toBe(9);
  });

  it('says so rather than guessing when nothing identifies the shift', async () => {
    const r = await runYan(home, ['report', 'done', 'nobody knows who I am'], {
      YAN_SHIFT_DIR: '',
      YAN_TASK_DIR: '',
      YAN_TASK: '',
      YAN_SID: '',
    });
    expect(r.code).toBe(2);
    expect(r.out).toContain('YAN_SHIFT_DIR');
  });

  it('refuses an id that exists under two tasks rather than guessing at it', async () => {
    const r = await runYan(home, ['report', 'done', 'ambiguous'], {
      YAN_SID: 's1',
      YAN_TASK: '',
      YAN_TASK_DIR: '',
      YAN_SHIFT_DIR: '',
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('--task');
  });
});
