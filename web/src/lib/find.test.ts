import { describe, expect, it } from 'vitest';
import type { TaskSummary } from './api';
import { findTasks } from './find';

const task = (id: string, title: string, state = 'open', touched = 0): TaskSummary =>
  ({ id, title, state, touched, createdAt: null, closedAt: null, repos: [], deliverables: { done: 0, todo: 0, abandoned: 0 }, agents: [], artifacts: 0, added: [], rev: '' }) as TaskSummary;

const ids = (tasks: readonly TaskSummary[], query: string, recent: string[] = [], current: string | null = null): string[] =>
  findTasks(tasks, query, recent, current).map((f) => f.task.id);

describe('finding a task', () => {
  it('puts a title that starts with what was typed first, then a word in it, then anywhere', () => {
    const tasks = [task('t1', 'relogin flow'), task('t2', 'fix login'), task('t3', 'login page')];
    expect(ids(tasks, 'login')).toEqual(['t3', 't2', 't1']);
    expect(ids([task('t1', '批量导出'), task('t2', '导出 CSV')], '导出')).toEqual(['t2', 't1']);
  });

  it('finds the letters in order with others between, and marks them', () => {
    const [found] = findTasks([task('t1', 'dark mode'), task('t2', 'export')], 'dkm', [], null);
    expect(found?.task.id).toBe('t1');
    expect(found?.marks).toEqual([[0, 1], [3, 4], [5, 6]]);
  });

  it('needs every word typed to match, in any order', () => {
    const tasks = [task('t1', '导出 CSV'), task('t2', '导出 PDF')];
    expect(ids(tasks, 'csv 导出')).toEqual(['t1']);
  });

  it('takes an id typed whole or by its number', () => {
    const tasks = [task('t042', 'something'), task('t420', 'other 42')];
    expect(ids(tasks, '42')[0]).toBe('t042');
    expect(ids(tasks, 't420')[0]).toBe('t420');
  });

  it('puts, of tasks that match as well, one in UAT first, then in progress, then done, then given up', () => {
    const tasks = [task('t1', 'login', 'abandoned', 9), task('t2', 'login', 'done', 8), task('t3', 'login', 'open', 1), task('t4', 'login', 'uat', 2), task('t5', 'login', 'open', 3)];
    expect(ids(tasks, 'login')).toEqual(['t4', 't5', 't3', 't2', 't1']);
    expect(ids([task('t1', 'login page', 'abandoned'), task('t2', 'fix login', 'uat')], 'login'), 'a better match still comes first').toEqual(['t1', 't2']);
  });

  it('takes a task in a state a newer yan wrote as one in progress, ranked and offered as such', () => {
    const tasks = [task('t1', 'login', 'done', 9), task('t2', 'login', 'paused', 1), task('t3', 'login', 'open', 2)];
    expect(ids(tasks, 'login')).toEqual(['t3', 't2', 't1']);
    expect(findTasks(tasks, '', [], null).map((f) => `${f.group} ${f.task.id}`)).toEqual(['Open t3', 'Open t2']);
  });

  it('lists, with nothing typed, the tasks visited last but the one being read, then the open ones', () => {
    const tasks = [task('t1', 'a', 'open', 1), task('t2', 'b', 'open', 5), task('t3', 'c', 'done'), task('t4', 'd', 'uat', 3)];
    const found = findTasks(tasks, '  ', ['t1', 't3', 't2'], 't1');
    expect(found.map((f) => `${f.group} ${f.task.id}`)).toEqual(['Recent t3', 'Recent t2', 'Open t4']);
    expect(findTasks([task('t1', 'a', 'open', 9), task('t2', 'b', 'uat', 1)], '', [], null).map((f) => f.task.id), 'one in UAT before one in progress').toEqual(['t2', 't1']);
  });
});
