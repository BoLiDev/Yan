import { describe, expect, it } from 'vitest';
import type { Index, Push, TaskSummary } from './api';
import { feedFiles, initSeen, latestUnseen, markAllSeen, markLooked, markTaskRead, unseenOf, unseenPushes, type Seen } from './seen';

const task = (id: string, touched: number): TaskSummary => ({
  id, title: id, state: 'open', createdAt: null, closedAt: null, repos: [], deliverables: { done: 0, todo: 0, abandoned: 0 }, agents: [],
  artifacts: 0, added: [], touched, rev: id,
});

const push = (task: string, at: number, files: [string, 'A' | 'M' | 'D', number?][]): Push => ({
  task, at, files: files.map(([path, status, fileAt]) => ({ path, sha: status === 'D' ? '' : `${path}@${fileAt ?? at}`, status, at: fileAt ?? at })),
});

function vault(latest: Push[]): Index {
  return {
    tasks: [task('t1', 300), task('t2', 200)],
    latest,
    status: { version: 1, commit: null, checkedAt: null, pulledAt: null, ok: true, error: null, everyS: 10, local: false, build: '' },
    vault: { name: 'v', dir: '/v', fileLink: null },
    filesOrigin: '',
  };
}

describe('what is new since the last look', () => {
  // t1 pushed twice after the mark (100), t2 once; a.png changed in both of t1's pushes.
  const index = vault([
    push('t1', 300, [['a.png', 'M'], ['gone.txt', 'D', 290]]),
    push('t2', 200, [['b.md', 'A']]),
    push('t1', 150, [['a.png', 'A'], ['c.txt', 'A']]),
  ]);
  const seen: Seen = { init: 100, tasks: {}, problems: {}, logs: {}, files: {} };

  it('starts a first visit from the vault as it is, and keeps what this browser had', () => {
    expect(initSeen(index, null).init).toBe(300);
    expect(initSeen(index, { tasks: { t1: 5 }, init: 1 })).toEqual({ init: 1, tasks: { t1: 5 }, problems: {}, logs: {}, files: {} });
  });

  it('puts a dot on each file changed since the mark, as its last change, and none on one deleted', () => {
    const t1 = unseenOf(index, seen, 't1');
    expect([...t1.keys()]).toEqual(['a.png', 'c.txt']);
    expect(t1.get('a.png')?.status).toBe('M');
    expect(latestUnseen(index, seen)).toBe(2);
  });

  it('clears a file looked at, and moves the mark up once the task has no dot left', () => {
    const one = markLooked(index, seen, 't1', 'a.png') as Seen;
    expect([...unseenOf(index, one, 't1').keys()]).toEqual(['c.txt']);
    expect(markLooked(index, one, 't1', 'a.png'), 'no dot, nothing to clear').toBeNull();
    const both = markLooked(index, one, 't1', 'c.txt') as Seen;
    expect(both.tasks.t1).toBe(300);
    expect(both.files.t1).toBeUndefined();
    expect(unseenPushes(index, both).map((p) => p.task)).toEqual(['t2']);
  });

  it('lists in Latest every push of a task that still has a dot, and its files once each', () => {
    expect(unseenPushes(index, seen).map((p) => `${p.task}@${p.at}`)).toEqual(['t1@300', 't2@200', 't1@150']);
    expect(feedFiles(index, seen).map((f) => `${f.task}/${f.path}`)).toEqual(['t1/a.png', 't2/b.md', 't1/c.txt']);
  });

  it('reads a whole task at once, its log too, or everything', () => {
    const read = markTaskRead(index, seen, 't1', 4);
    expect(unseenOf(index, read, 't1').size).toBe(0);
    expect(read.logs.t1).toBe(4);
    expect(latestUnseen(index, markAllSeen(index, seen))).toBe(0);
  });
});
