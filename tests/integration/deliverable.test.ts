import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan, type RunResult } from '../helpers/fixtures.js';

/**
 * `yan deliverable`. Every subcommand is driven through `bin/yan`, because
 * what is being pinned is the pair of writes each one makes: the record, and
 * the one log line that says how it moved. Nothing here touches the real
 * vault.
 */

afterAll(cleanupTempDirs);

let home = '';

/** In the task, the way the main agent runs it. */
function yan(args: readonly string[], task = 't042'): Promise<RunResult> {
  return runYan(home, args, { YAN_TASK: task });
}

function file(): { version: number; nextId: number; deliverables: Record<string, unknown>[] } {
  return JSON.parse(readFileSync(join(home, 'tasks', 't042', 'deliverable.json'), 'utf8')) as ReturnType<typeof file>;
}

function log(): string {
  return readFileSync(join(home, 'tasks', 't042', 'log.md'), 'utf8');
}

/** The log entries this test wrote, without their dates. */
function entries(): string[] {
  return log()
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.replace(/^- \d{2}-\d{2} {2}/, ''));
}

beforeEach(async () => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  const previous = process.env.YAN_HOME;
  process.env.YAN_HOME = home;
  const { Task } = await import('../../src/records/task/index.js');
  Task.create('t042', 'unify the auth header');
  Task.create('t043', 'a finished one');
  new (await import('../../src/records/task/index.js')).Task('t043').setComplete(true);
  if (previous === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previous;
});

describe('add', () => {
  it('appends several in one call, and logs them as one changed line', async () => {
    const r = await yan(['deliverable', 'add', 'yan ls is an overview.', 'The report shows a brief.']);
    expect(r.code, r.out).toBe(0);
    expect(file().deliverables).toEqual([
      { id: 'd1', text: 'yan ls is an overview.', status: 'todo' },
      { id: 'd2', text: 'The report shows a brief.', status: 'todo' },
    ]);
    expect(entries()).toEqual([
      'changed    d1 d2  added: "yan ls is an overview." · "The report shows a brief."',
    ]);
  });

  it('puts --note on the same line', async () => {
    await yan(['deliverable', 'add', 'one', '--note', 'user asked for this in the first session']);
    expect(entries()[0]).toBe('changed    d1  added: "one" — user asked for this in the first session');
  });

  it('refuses nothing to add, and writes no log line', async () => {
    const r = await yan(['deliverable', 'add']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('at least one');
    expect(entries()).toEqual([]);
  });
});

describe('the rest of the moves', () => {
  beforeEach(async () => {
    await yan(['deliverable', 'add', 'first', 'second', 'third']);
  });

  it('rewords one', async () => {
    expect((await yan(['deliverable', 'set', 'd2', 'second, said better'])).code).toBe(0);
    expect(file().deliverables[1]).toEqual({ id: 'd2', text: 'second, said better', status: 'todo' });
    expect(entries()[1]).toBe('changed    d2  reworded: "second, said better"');
  });

  it('marks one delivered, as a delivered line', async () => {
    const r = await yan(['deliverable', 'done', 'd1', '--ref', 'PR #58', '--ref', 'PR #59', '--at', '2026-09-18']);
    expect(r.code, r.out).toBe(0);
    expect(file().deliverables[0]).toEqual({
      id: 'd1',
      text: 'first',
      status: 'done',
      doneAt: '2026-09-18',
      refs: ['PR #58', 'PR #59'],
    });
    expect(entries()[1]).toBe('delivered  d1  done 2026-09-18, PR #58 PR #59: "first"');
  });

  it('defaults --at to today and refuses a date that is not one', async () => {
    expect((await yan(['deliverable', 'done', 'd1'])).code).toBe(0);
    expect(file().deliverables[0]?.doneAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const r = await yan(['deliverable', 'done', 'd2', '--at', '09-18']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('YYYY-MM-DD');
    expect(file().deliverables[1]?.status).toBe('todo');
  });

  it('refuses abandon without a reason, and keeps the reason when there is one', async () => {
    const refused = await yan(['deliverable', 'abandon', 'd3']);
    expect(refused.code).toBe(2);
    expect(refused.out).toContain('--reason is required');
    expect(file().deliverables[2]?.status).toBe('todo');

    expect((await yan(['deliverable', 'abandon', 'd3', '--reason', 'yan show is where those are read'])).code).toBe(0);
    expect(file().deliverables[2]).toEqual({
      id: 'd3',
      text: 'third',
      status: 'abandoned',
      reason: 'yan show is where those are read',
    });
    expect(entries()[1]).toBe('changed    d3  abandoned: yan show is where those are read');
  });

  it('puts one back to to-do', async () => {
    await yan(['deliverable', 'done', 'd1', '--at', '2026-09-18', '--ref', 'PR #58']);
    expect((await yan(['deliverable', 'todo', 'd1'])).code).toBe(0);
    expect(file().deliverables[0]).toEqual({ id: 'd1', text: 'first', status: 'todo' });
    expect(entries()[2]).toBe('changed    d1  back to to-do');
  });

  it('removes one and never hands its id out again', async () => {
    expect((await yan(['deliverable', 'rm', 'd2'])).code).toBe(0);
    expect(file().deliverables.map((d) => d.id)).toEqual(['d1', 'd3']);
    expect(entries()[1]).toBe('changed    d2  removed: "second"');
    await yan(['deliverable', 'add', 'fourth']);
    expect(file().deliverables.map((d) => d.id)).toEqual(['d1', 'd3', 'd4']);
  });

  it('refuses an unknown id, names the ids there are, and logs nothing', async () => {
    const before = entries().length;
    for (const args of [['set', 'd9', 'x'], ['done', 'd9'], ['abandon', 'd9', '--reason', 'x'], ['todo', 'd9'], ['rm', 'd9']]) {
      const r = await yan(['deliverable', ...args]);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.out).toContain('no such deliverable: d9');
      expect(r.out).toContain('this task has d1 d2 d3');
    }
    expect(entries()).toHaveLength(before);
  });

  it('refuses a subcommand with no id at all', async () => {
    for (const verb of ['set', 'done', 'abandon', 'todo', 'rm']) {
      expect((await yan(['deliverable', verb])).code, verb).toBe(2);
    }
  });
});

describe('ls', () => {
  it('prints the file object as it is with --json', async () => {
    await yan(['deliverable', 'add', 'first', 'second']);
    await yan(['deliverable', 'done', 'd1', '--at', '2026-09-18', '--ref', 'PR #58']);
    const r = await yan(['deliverable', 'ls', '--json']);
    expect(r.code, r.out).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual(file());
  });

  it('prints a line per deliverable, and its date and refs under it', async () => {
    await yan(['deliverable', 'add', 'first', 'second']);
    await yan(['deliverable', 'done', 'd1', '--at', '2026-09-18', '--ref', 'PR #58']);
    await yan(['deliverable', 'abandon', 'd2', '--reason', 'user reads that off the header']);
    const r = await yan(['deliverable', 'ls']);
    expect(r.stdout).toContain('  d1  done       first');
    expect(r.stdout).toContain('2026-09-18 · PR #58');
    expect(r.stdout).toContain('  d2  abandoned  second');
    expect(r.stdout).toContain('user reads that off the header');
    expect(r.stdout).toContain('1 done · 1 abandoned');
  });

  it('says there are none, and how to write the first', async () => {
    const r = await yan(['deliverable', 'ls']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('no deliverables yet');
    expect(r.out).toContain('yan deliverable add');
  });

  it('refuses a file that does not validate, and says what is wrong with it', async () => {
    writeFileSync(
      join(home, 'tasks', 't042', 'deliverable.json'),
      `${JSON.stringify({ version: 1, nextId: 2, deliverables: [{ id: 'd1', text: 'x', status: 'shipped' }] }, null, 2)}\n`,
    );
    const r = await yan(['deliverable', 'ls']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('status "shipped"');
    expect((await yan(['deliverable', 'add', 'one'])).code, 'and so does a write').toBe(1);
  });
});

describe('which task', () => {
  it('reads $YAN_TASK, and refuses when it is unset or names no task', async () => {
    expect((await runYan(home, ['deliverable', 'ls'], { YAN_TASK: '' })).code).toBe(2);
    const r = await yan(['deliverable', 'ls'], 't404');
    expect(r.code).toBe(2);
    expect(r.out).toContain('no such task: t404');
  });

  it('never prompts: no terminal, no question, just the refusal', async () => {
    const r = await runYan(home, ['deliverable', 'add'], { YAN_TASK: 't042' });
    expect(r.code).toBe(2);
    expect(r.out).not.toContain('?');
  });
});

describe('who reads it', () => {
  it('session-start prints the block, and the notice while the list is empty', async () => {
    const empty = await runYan(home, ['session-start', 't042']);
    expect(empty.code, empty.out).toBe(0);
    expect(empty.stdout).toContain('── deliverables  none yet');
    expect(empty.stdout).toContain('This task has never been broken down');
    expect(empty.stdout).toContain('yan deliverable add');

    await yan(['deliverable', 'add', 'first', 'second']);
    await yan(['deliverable', 'done', 'd1', '--at', '2026-09-18', '--ref', 'PR #58']);
    const full = await runYan(home, ['session-start', 't042']);
    expect(full.stdout).toContain('── deliverables  1 done · 1 to do');
    expect(full.stdout).toContain('  d1  done       first');
    expect(full.stdout).toContain('2026-09-18 · PR #58');
    expect(full.stdout).not.toContain('This task has never been broken down');
  });

  it('does not push a finished task to break its brief down', async () => {
    const r = await runYan(home, ['session-start', 't043']);
    expect(r.stdout).toContain('── deliverables  none recorded');
    expect(r.stdout).not.toContain('This task has never been broken down');
  });

  it('reports an unreadable file at session start without failing', async () => {
    writeFileSync(join(home, 'tasks', 't042', 'deliverable.json'), 'not json\n');
    const r = await runYan(home, ['session-start', 't042']);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('── deliverables  UNREADABLE');
    expect(r.stdout).toContain('not valid JSON');
    expect(r.stdout, 'the rest of the session still starts').toContain('── log');
  });

  it('yan show prints them under the description', async () => {
    await yan(['deliverable', 'add', 'first']);
    await yan(['deliverable', 'done', 'd1', '--at', '2026-09-18']);
    const r = await runYan(home, ['show', 't042']);
    expect(r.code, r.out).toBe(0);
    const plain = r.stdout.replace(/\u001B\[[0-9;]*m/g, '');
    expect(plain).toContain('Deliverables  1 done');
    expect(plain).toContain('d1  done       first');
    expect(plain.indexOf('Deliverables'), 'above the units').toBeLessThan(plain.indexOf('Units'));

    const json = await runYan(home, ['show', 't042', '--json']);
    const doc = JSON.parse(json.stdout.trim()) as { deliverables: unknown[]; deliverables_problem: string | null };
    expect(doc.deliverables).toEqual(file().deliverables);
    expect(doc.deliverables_problem).toBe(null);
  });
});
