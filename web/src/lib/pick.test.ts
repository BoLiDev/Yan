import { describe, expect, it } from 'vitest';
import { findPicks, packageOn, stateOf, tickPackage, tickRepo, type Picked, type RepoOption } from './pick';

const app: RepoOption = { name: 'app', packages: [] };
const web: RepoOption = { name: 'web', packages: ['apps/site', 'packages/core', 'packages/web'] };

describe('picking a new task\'s repositories as a cascading select', () => {
  it('takes a repository ticked as the whole of it, and ticked again as none', () => {
    let p: Picked = {};
    p = tickRepo(p, app);
    expect(p).toEqual({ app: [] });
    expect(stateOf(p, app)).toBe('on');
    expect(tickRepo(p, app)).toEqual({});
  });

  it('narrows a repository to the packages ticked, part-ticking it, until all are, which is the whole of it', () => {
    let p: Picked = tickPackage({}, web, 'packages/core');
    expect(p).toEqual({ web: ['packages/core'] });
    expect(stateOf(p, web)).toBe('some');
    expect([packageOn(p, web, 'packages/core'), packageOn(p, web, 'apps/site')]).toEqual([true, false]);
    p = tickPackage(tickPackage(p, web, 'apps/site'), web, 'packages/web');
    expect(p, 'all of them ticked').toEqual({ web: [] });
    expect(stateOf(p, web)).toBe('on');
    p = tickPackage(p, web, 'apps/site');
    expect(p, 'one let go of the whole').toEqual({ web: ['packages/core', 'packages/web'] });
    expect(tickRepo(p, web), 'a part-ticked one ticked is all of it').toEqual({ web: [] });
    expect(tickPackage(tickPackage({}, web, 'apps/site'), web, 'apps/site'), 'the last let go is none').toEqual({});
  });

  it('finds repositories and packages by any words typed, a package by its path', () => {
    const repos = [app, web];
    expect(findPicks(repos, 'core').map((h) => h.label)).toEqual(['web / packages/core']);
    expect(findPicks(repos, 'web').map((h) => h.label), 'the repository itself first, then what is in it, in the list\'s order').toEqual(['web', 'web / apps/site', 'web / packages/core', 'web / packages/web']);
    expect(findPicks(repos, 'web core').map((h) => h.label)).toEqual(['web / packages/core']);
    expect(findPicks(repos, 'pkcr').map((h) => h.label), 'letters in order').toEqual(['web / packages/core']);
    expect(findPicks(repos, 'zzz')).toEqual([]);
    expect(findPicks(repos, 'core')[0]?.marks, 'where it matched, to mark').toEqual([[15, 19]]);
  });
});
