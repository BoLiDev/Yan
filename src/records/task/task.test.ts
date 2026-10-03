import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { Task } from './index.js';

beforeEach(() => {
  mkYanHome(mkTempDir());
});

afterAll(cleanupTempDirs);

const raw = (task: Task): Record<string, unknown> => JSON.parse(readFileSync(task.file, 'utf8')) as Record<string, unknown>;

describe('create', () => {
  it('takes the next t<NNN>, writes a version 2 task.json and an empty problem.md, and no log yet', () => {
    const first = Task.create('first');
    const second = Task.create('second', [{ url: 'git@github.com:me/repo.git', scope: [] }, { url: 'git@github.com:me/web.git', scope: ['apps/site'] }]);
    expect([first.id, second.id]).toEqual(['t001', 't002']);
    expect(raw(second)).toMatchObject({
      version: 2,
      id: 't002',
      title: 'second',
      state: 'open',
      repos: [{ url: 'git@github.com:me/repo.git' }, { url: 'git@github.com:me/web.git', scope: ['apps/site'] }],
      nextDeliverable: 1,
      deliverables: [],
    });
    expect('repos' in raw(first)).toBe(false);
    expect(first.read().repos).toEqual([]);
    expect(first.problem).toBe(join(first.dir, 'problem.md'));
    expect(readFileSync(first.problem, 'utf8')).toBe('');
    expect('resources' in raw(first)).toBe(false);
    expect(Task.list()).toEqual(['t001', 't002']);
  });

  it('refuses an empty or multi-line title', () => {
    expect(() => Task.create('  ')).toThrow(/title/);
    expect(() => Task.create('a\nb')).toThrow(/title/);
  });
});

describe('read', () => {
  it('refuses a version 1 task.json', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ version: 1, id: task.id, title: 'x', complete: false, units: [] }));
    expect(() => task.read()).toThrow(/reads only version 2/);
  });

  it('refuses a deliverable it cannot read rather than guess', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ ...raw(task), deliverables: [{ id: 'd1', text: 't', status: 'maybe' }] }));
    expect(() => task.read()).toThrow(/d1 has status "maybe"/);
  });

  it('reads the one repo and scope a task had before it could have several', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ ...raw(task), repo: 'git@github.com:me/repo.git', scope: ['packages/a', 7] }));
    expect(task.read().repos).toEqual([{ url: 'git@github.com:me/repo.git', scope: ['packages/a'] }]);
  });

  it('keeps a field it does not know through a write', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ ...raw(task), extra: 42 }));
    task.addDeliverables(['it works']);
    expect(raw(task).extra).toBe(42);
  });
});

describe('deliverables', () => {
  it('numbers them, and never reuses an id', () => {
    const task = Task.create('x');
    expect(task.addDeliverables(['one', 'two']).map((d) => d.id)).toEqual(['d1', 'd2']);
    writeFileSync(task.file, JSON.stringify({ ...raw(task), deliverables: [] }));
    expect(task.addDeliverables(['three'])[0]?.id).toBe('d3');
  });

  it('edits, marks done today and abandons with a reason', () => {
    const task = Task.create('x');
    task.addDeliverables(['one', 'two']);
    expect(task.editDeliverable('d1', 'one, reworded').text).toBe('one, reworded');
    expect(task.deliverableDone('d1')).toMatchObject({ status: 'done', doneAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(task.abandonDeliverable('d2', 'not needed')).toEqual({ id: 'd2', text: 'two', status: 'abandoned', reason: 'not needed' });
    expect(task.read().deliverables.map((d) => d.status)).toEqual(['done', 'abandoned']);
  });

  it('names the ids there are when asked for one that is not', () => {
    const task = Task.create('x');
    task.addDeliverables(['one']);
    expect(() => task.deliverableDone('d9')).toThrow(/this task has d1/);
    expect(() => task.addDeliverables(['a\nb'])).toThrow(/one line/);
  });
});

describe('problem', () => {
  it('is brief.md for a task from before problem.md, until a problem.md appears beside it', () => {
    const task = Task.create('x');
    renameSync(task.problem, join(task.dir, 'brief.md'));
    expect(task.problem).toBe(join(task.dir, 'brief.md'));
    writeFileSync(join(task.dir, 'problem.md'), 'now');
    expect(task.problem).toBe(join(task.dir, 'problem.md'));
  });

  it('is problem.md when neither file is there', () => {
    const task = Task.create('x');
    renameSync(task.problem, join(task.dir, 'gone.md'));
    expect(task.problem).toBe(join(task.dir, 'problem.md'));
    expect(existsSync(task.problem)).toBe(false);
  });
});

describe('resources', () => {
  it('keeps any line under a name, replaces a name kept again, and forgets one', () => {
    const task = Task.create('x');
    expect(task.addResource(' PROJ-412 ', 'https://jira.example.com/browse/PROJ-412')).toBe(false);
    expect(task.addResource('设计文档', '~/notes/design.md')).toBe(false);
    expect(task.addResource('PROJ-412', 'jira:PROJ-412')).toBe(true);
    expect(task.read().resources).toEqual({ 'PROJ-412': 'jira:PROJ-412', 设计文档: '~/notes/design.md' });

    task.removeResource('PROJ-412');
    task.removeResource('设计文档');
    expect('resources' in raw(task)).toBe(false);
    expect(() => task.removeResource('PROJ-412')).toThrow(/this task has none/);
  });

  it('refuses a blank or multi-line name or value, and names what there is', () => {
    const task = Task.create('x');
    expect(() => task.addResource('', 'x')).toThrow(/blank/);
    expect(() => task.addResource('a', 'x\ny')).toThrow(/one line/);
    task.addResource('a', 'x');
    expect(() => task.removeResource('b')).toThrow(/this task has a/);
  });

  it('reads past an entry edited into something that is not a line of text', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ ...raw(task), resources: { ok: 'x', blank: ' ', n: 3 } }));
    expect(task.read().resources).toEqual({ ok: 'x' });
    writeFileSync(task.file, JSON.stringify({ ...raw(task), resources: ['x'] }));
    expect(task.read().resources).toEqual({});
  });
});

describe('close', () => {
  it('stamps closedAt, and keeps a reason only for an abandoned task', () => {
    const task = Task.create('x');
    task.close('abandoned', 'out of scope');
    expect(task.read()).toMatchObject({ state: 'abandoned', reason: 'out of scope' });
    expect(task.read().closedAt).toMatch(/Z$/);
    task.close('done', 'ignored');
    expect(task.read().state).toBe('done');
    expect(task.read().reason).toBeUndefined();
  });
});
