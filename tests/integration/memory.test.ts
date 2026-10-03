import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { Task } from '../../src/records/task/index.js';
import { localMonthDay } from '../../src/util/time.js';

/**
 * What yan is for: an agent picks a task up in a later session and finds what
 * the earlier ones settled. Each `yan` call is a separate process, as it is
 * for an agent; the "sessions" are only the order of the calls.
 */

afterAll(cleanupTempDirs);

let home = '';

function yan(args: readonly string[], env: Record<string, string | undefined> = {}) {
  return runYan(home, args, env);
}

beforeEach(() => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  Task.create('pricing page');
});

describe('a later session picks the task up', () => {
  it('finds the problem, the solution as it stands, and every decision, however long the log grew', async () => {
    // Session one, started by `yan`: the agent learns the task and records it.
    const first = { YAN_TASK: 't001' };
    writeFileSync(new Task('t001').problem, 'Nobody can tell what a plan costs without writing to us.\n');
    await yan(['deliverable', 'add', 'the page compares the three plans', 'the yearly price says what it saves'], first);
    await yan(['log', 'agreed', 'prices in euros only - every customer pays in euros'], first);
    for (let i = 1; i <= 12; i += 1) await yan(['log', 'paused', `stopped at step ${i}`], first);
    await yan(['deliverable', 'done', 'd1'], first);

    // Session two, another day: the agent reads before it works.
    const peek = await yan(['peek'], first);
    expect(peek.code, peek.out).toBe(0);
    expect(peek.stdout).toContain('Nobody can tell what a plan costs');
    expect(peek.stdout).toMatch(/d1 {2}done {7}the page compares the three plans/);
    expect(peek.stdout).toMatch(/d2 {2}todo {7}the yearly price says what it saves/);

    const log = await yan(['log'], first);
    expect(log.stdout).toContain('prices in euros only');
    expect(log.stdout).toContain('stopped at step 12');
    expect(log.stdout, 'the tail is ten lines, the decision is kept from before it').not.toContain('stopped at step 2\n');
    expect(log.stdout).toContain('(2 older lines left out');
  });

  it('works from a session yan did not start, once the task is named', async () => {
    const listed = await yan(['ls'], { YAN_TASK: undefined });
    expect(listed.stdout).toMatch(/^t001 {2}open .* pricing page$/m);

    expect((await yan(['log', 'agreed', 'monthly billing only', '--task', 't001'])).code).toBe(0);
    expect((await yan(['log', '--task', 't001'])).stdout).toContain('monthly billing only');
    expect((await yan(['peek', 't001'])).stdout).toContain('t001  pricing page');
  });
});

describe('yan ls says when a task last moved', () => {
  it('from its records, not from when the files were written', async () => {
    await yan(['log', 'agreed', 'a decision today'], { YAN_TASK: 't001' });

    // A task as a clone of the vault brings it: files new, records old.
    const old = Task.create('from last year');
    writeFileSync(old.file, JSON.stringify({
      version: 2, id: old.id, title: 'from last year', state: 'open', createdAt: '2025-03-01T12:00:00Z',
      nextDeliverable: 2, deliverables: [{ id: 'd1', text: 'x', status: 'done', doneAt: '2025-03-05' }],
    }));

    const ls = (await yan(['ls'])).stdout;
    expect(ls).toMatch(new RegExp(`^t001 .* ${localMonthDay()} +pricing page$`, 'm'));
    expect(ls).toMatch(/^t002 .* 2025-03-05 {2}from last year$/m);
  });
});
