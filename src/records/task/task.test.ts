import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { Task } from './index.js';

beforeEach(() => {
  mkYanHome(mkTempDir());
});

afterAll(cleanupTempDirs);

const raw = (task: Task): Record<string, unknown> => JSON.parse(readFileSync(task.file, 'utf8')) as Record<string, unknown>;

describe('create', () => {
  it('takes the next t<NNN>, writes a version 2 task.json and an empty brief, and no log yet', () => {
    const first = Task.create('first');
    const second = Task.create('second', 'git@github.com:me/repo.git');
    expect([first.id, second.id]).toEqual(['t001', 't002']);
    expect(raw(second)).toMatchObject({
      version: 2,
      id: 't002',
      title: 'second',
      state: 'open',
      repo: 'git@github.com:me/repo.git',
      nextDeliverable: 1,
      deliverables: [],
    });
    expect('repo' in raw(first)).toBe(false);
    expect(readFileSync(first.brief, 'utf8')).toBe('');
    expect(Task.list()).toEqual(['t001', 't002']);
  });

  it('refuses an empty or multi-line title', () => {
    expect(() => Task.create('  ')).toThrow(/title/);
    expect(() => Task.create('a\nb')).toThrow(/title/);
  });
});

describe('read', () => {
  it('refuses a version 1 task.json and names the migration', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ version: 1, id: task.id, title: 'x', complete: false, units: [] }));
    expect(() => task.read()).toThrow(/migrate-v4/);
  });

  it('refuses a deliverable it cannot read rather than guess', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ ...raw(task), deliverables: [{ id: 'd1', text: 't', status: 'maybe' }] }));
    expect(() => task.read()).toThrow(/d1 has status "maybe"/);
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
