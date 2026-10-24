import { describe, expect, it } from 'vitest';
import { link, parseRoute, viewKey } from './route';

describe('routes', () => {
  it('reads every view from the hash, and each link back to it', () => {
    expect(parseRoute('')).toEqual({ view: 'latest' });
    expect(parseRoute('#/latest/t1/c4/a b.png')).toEqual({ view: 'latest', id: 't1', path: 'c4/a b.png' });
    expect(parseRoute(link.task('t1'))).toEqual({ view: 'task', id: 't1', sub: 'overview' });
    expect(parseRoute(link.log('t1'))).toEqual({ view: 'task', id: 't1', sub: 'log' });
    expect(parseRoute(link.report('t1'))).toEqual({ view: 'task', id: 't1', sub: 'report' });
    expect(parseRoute(link.file('t1', 'uat/d1 after.png'))).toEqual({ view: 'task', id: 't1', sub: 'file', path: 'uat/d1 after.png' });
    expect(parseRoute(link.folder('t1', 'uat'))).toEqual({ view: 'task', id: 't1', sub: 'folder', path: 'uat' });
    expect(parseRoute(link.folder('t1', ''))).toEqual({ view: 'task', id: 't1', sub: 'folder', path: '' });
  });

  it('tells the branch the tree was last on from another of the task’s by whether a name comes before the tab', () => {
    expect(parseRoute(link.branch('t1', 0))).toEqual({ view: 'task', id: 't1', sub: 'branch', repo: 0, name: null, tab: 'changes', item: '' });
    expect(parseRoute(link.branch('t1', 1, 'commits', 'abc'))).toMatchObject({ repo: 1, name: null, tab: 'commits', item: 'abc' });
    expect(parseRoute(link.branch('t1', 0, 'files', 'src/a.ts', 'yan/t1-old'))).toMatchObject({ name: 'yan/t1-old', tab: 'files', item: 'src/a.ts' });
  });

  it('keeps a view while what it shows stays the same, whatever moves inside it', () => {
    expect(viewKey(parseRoute(link.task('t1')))).toBe(viewKey(parseRoute('#/t/t1')));
    expect(viewKey(parseRoute(link.file('t1', 'a.png')))).not.toBe(viewKey(parseRoute(link.file('t1', 'b.png'))));
    expect(viewKey(parseRoute(link.task('t1')))).not.toBe(viewKey(parseRoute(link.log('t1'))));
  });
});
