import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome } from '../../../tests/helpers/fixtures.js';
import { Task, Uat, branchMark, type TaskRepo } from './index.js';

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
  it('numbers them after the last one, even when one was taken out by hand', () => {
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

describe('taking a deliverable out and moving one', () => {
  const ids = (task: Task): string => task.read().deliverables.map((d) => `${d.id} ${d.text}`).join(', ');

  it('takes one out as if it had never been added: the ones after it move up, and the next added comes after the last', () => {
    const task = Task.create('x');
    task.addDeliverables(['one', 'two', 'three']);
    task.deliverableDone('d3');
    const out = task.removeDeliverable('d2');
    expect(ids(task)).toBe('d1 one, d2 three');
    expect(out.renumbered).toEqual([['d3', 'd2']]);
    expect(task.read().deliverables[1]).toMatchObject({ status: 'done' });
    expect(raw(task).nextDeliverable).toBe(3);
    expect(task.addDeliverables(['four'])[0]?.id).toBe('d3');
    expect(() => task.removeDeliverable('d9')).toThrow(/this task has d1 d2 d3/);
  });

  it('moves one to a place, every one between taking the number of its new place', () => {
    const task = Task.create('x');
    task.addDeliverables(['one', 'two', 'three', 'four']);
    task.moveDeliverable('d4', 2);
    expect(ids(task)).toBe('d1 one, d2 four, d3 two, d4 three');
    task.moveDeliverable('d1', 4);
    expect(ids(task)).toBe('d1 four, d2 two, d3 three, d4 one');
    expect(() => task.moveDeliverable('d1', 5)).toThrow(/runs from 1 to 4/);
    expect(() => task.moveDeliverable('d1', 0)).toThrow(/runs from 1 to 4/);
  });

  it('takes the evidence of the one taken out with it, and gives the rest their new numbers, in uat.json and in the names of the files', () => {
    const task = Task.create('x');
    task.addDeliverables(['one', 'two', 'three']);
    const uat = new Uat(task);
    mkdirSync(join(uat.dir, 'more'), { recursive: true });
    const shot = (name: string): void => writeFileSync(join(uat.dir, name), name);
    ['d1-before.png', 'd2-after.png', 'd2-d3-after.png', 'd3.webm', 'd2-old.png', 'more/after-d3.png', 'overview.png'].forEach(shot);
    uat.add('d1-before.png', ['d1'], 'one before', 'before');
    uat.add('d2-after.png', ['d2'], 'two after', 'after');
    uat.add('d2-d3-after.png', ['d2', 'd3'], 'two and three');
    uat.add('d3.webm', ['d3'], 'three recorded');
    uat.add('more/after-d3.png', ['d3'], 'three, in a folder');
    uat.add('overview.png', ['d2'], 'two, named for nothing');
    uat.note(['d2'], 'two checked by hand');
    uat.note(['d3'], 'three checked by hand');

    const out = task.removeDeliverable('d2');
    expect([...out.uat.deleted].sort()).toEqual(['d2-after.png', 'd2-old.png', 'overview.png']);
    expect(readdirSync(uat.dir, { recursive: true }).map((p) => String(p).split(sep).join('/')).sort())
      .toEqual(['d1-before.png', 'd2-after.png', 'd2.webm', 'more', 'more/after-d2.png', 'uat.json']);
    // The file that showed two and three now shows only three, under three's new number.
    expect(readFileSync(join(uat.dir, 'd2-after.png'), 'utf8')).toBe('d2-d3-after.png');
    const data = uat.read();
    expect(Object.fromEntries(data.files.map((f) => [f.path, f.for]))).toEqual({
      'd1-before.png': ['d1'], 'd2-after.png': ['d2'], 'd2.webm': ['d2'], 'more/after-d2.png': ['d2'],
    });
    expect(data.files.find((f) => f.path === 'd1-before.png')).toMatchObject({ shows: 'one before', side: 'before' });
    expect(data.notes).toEqual({ d2: 'three checked by hand' });
  });

  it('renames through names nothing has, so a file never lands on one still waiting to move', () => {
    const task = Task.create('x');
    task.addDeliverables(['one', 'two', 'three']);
    const uat = new Uat(task);
    mkdirSync(uat.dir, { recursive: true });
    for (const id of ['d1', 'd2', 'd3']) {
      writeFileSync(join(uat.dir, `${id}.png`), id);
      uat.add(`${id}.png`, [id], id);
    }
    task.moveDeliverable('d3', 1);
    expect(['d1', 'd2', 'd3'].map((id) => readFileSync(join(uat.dir, `${id}.png`), 'utf8'))).toEqual(['d3', 'd1', 'd2']);
    expect(uat.read().files.map((f) => `${f.path} ${f.for.join()} ${f.shows}`).sort()).toEqual(['d1.png d1 d3', 'd2.png d2 d1', 'd3.png d3 d2']);
  });

  it('changes nothing when uat.json cannot be read', () => {
    const task = Task.create('x');
    task.addDeliverables(['one', 'two']);
    const uat = new Uat(task);
    mkdirSync(uat.dir, { recursive: true });
    writeFileSync(uat.file, '{ not json');
    expect(() => task.removeDeliverable('d1')).toThrow(/not valid JSON/);
    expect(ids(task)).toBe('d1 one, d2 two');
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
  it('keeps any line under a name as its kind, replaces a name kept again, and forgets one', () => {
    const task = Task.create('x');
    expect(task.addResource('spec', ' PROJ-412 ', 'https://jira.example.com/browse/PROJ-412')).toBe(false);
    expect(task.addResource('general', '设计文档', '~/notes/design.md')).toBe(false);
    expect(task.addResource('spec', 'PROJ-412', 'jira:PROJ-412')).toBe(true);
    expect(task.read().resources).toEqual({ 'PROJ-412': 'jira:PROJ-412', 设计文档: '~/notes/design.md' });
    expect(task.read().resourceKinds).toEqual({ 'PROJ-412': 'spec', 设计文档: 'general' });
    expect(raw(task).resources, 'resources stay a map of lines, which a yan from before kinds reads').toEqual({ 'PROJ-412': 'jira:PROJ-412', 设计文档: '~/notes/design.md' });

    task.removeResource('PROJ-412');
    expect(raw(task).resourceKinds).toEqual({ 设计文档: 'general' });
    task.removeResource('设计文档');
    expect('resources' in raw(task)).toBe(false);
    expect('resourceKinds' in raw(task)).toBe(false);
    expect(() => task.removeResource('PROJ-412')).toThrow(/this task has none/);
  });

  it('refuses a kind it does not know, a blank or multi-line name or value, and names what there is', () => {
    const task = Task.create('x');
    expect(() => task.addResource('ticket' as 'spec', 'a', 'x')).toThrow(/one of: spec mr preview run general/);
    expect(() => task.addResource('general', '', 'x')).toThrow(/blank/);
    expect(() => task.addResource('general', 'a', 'x\ny')).toThrow(/one line/);
    task.addResource('general', 'a', 'x');
    expect(() => task.removeResource('b')).toThrow(/this task has a/);
  });

  it('reads a resource with no kind, or one it does not know, as general, and writes such a kind back as it was', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ ...raw(task), resources: { old: 'x', newer: 'y', gone: 'z' }, resourceKinds: { newer: 'release', stale: 'mr' } }));
    expect(task.read().resourceKinds).toEqual({ old: 'general', newer: 'general', gone: 'general' });

    task.addResource('mr', 'web#7', 'https://github.com/me/web/pull/7');
    expect(raw(task).resourceKinds, 'a kind left behind by an older yan goes; one from a newer yan stays').toEqual({ newer: 'release', 'web#7': 'mr' });
  });

  it('reads past an entry edited into something that is not a line of text', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ ...raw(task), resources: { ok: 'x', blank: ' ', n: 3 } }));
    expect(task.read().resources).toEqual({ ok: 'x' });
    writeFileSync(task.file, JSON.stringify({ ...raw(task), resources: ['x'] }));
    expect(task.read().resources).toEqual({});
  });
});

describe('branches', () => {
  it('keeps them per repository, matching its URL however it is spelled, and says which the worktree was on before', () => {
    const task = Task.create('x', [{ url: 'git@github.com:me/web.git', scope: ['apps/site'] }, { url: 'git@github.com:me/api.git' }]);
    expect(task.keepBranch('https://github.com/me/api', 'feat/retry')).toBeUndefined();
    expect(task.keepBranch('git@github.com:me/api.git', 'feat/retry-2')).toBe('feat/retry');
    expect(task.read().repos).toEqual([
      { url: 'git@github.com:me/web.git', scope: ['apps/site'] },
      { url: 'git@github.com:me/api.git', branch: 'feat/retry-2', earlierBranches: ['feat/retry'], branchMarks: { 'feat/retry': 'open', 'feat/retry-2': 'open' } },
    ]);
  });

  it('writes into the entry as it stands, keeping a field it does not know, and refuses a repository the task lacks', () => {
    const task = Task.create('x', [{ url: 'git@github.com:me/web.git' }]);
    writeFileSync(task.file, JSON.stringify({ ...raw(task), repos: [{ url: '' }, { url: 'git@github.com:me/web.git', later: true }] }));
    task.keepBranch('git@github.com:me/web.git', 'feat/a');
    expect(raw(task).repos).toEqual([{ url: '' }, { url: 'git@github.com:me/web.git', later: true, branch: 'feat/a', branchMarks: { 'feat/a': 'open' } }]);

    expect(() => task.keepBranch('git@github.com:me/api.git', 'feat/a')).toThrow(/not a repository of this task - it works in git@github.com:me\/web.git/);
    expect(() => task.keepBranch('git@github.com:me/web.git', 'two words')).toThrow(/has a space in it/);
  });

  it('keeps every branch the work was on, oldest first, each in progress, and lets the work move back to one', () => {
    const task = Task.create('x', [{ url: 'git@github.com:me/web.git' }]);
    task.keepBranch('git@github.com:me/web.git', 'feat/a');
    task.keepBranch('git@github.com:me/web.git', 'feat/a');
    expect(task.read().repos[0]).toEqual({ url: 'git@github.com:me/web.git', branch: 'feat/a', branchMarks: { 'feat/a': 'open' } });
    task.keepBranch('git@github.com:me/web.git', 'feat/b');
    task.keepBranch('git@github.com:me/web.git', 'feat/c');
    const repo = task.read().repos[0] as TaskRepo;
    expect(repo).toMatchObject({ branch: 'feat/c', earlierBranches: ['feat/a', 'feat/b'] });
    expect(['feat/a', 'feat/b', 'feat/c'].map((b) => branchMark(repo, b))).toEqual(['open', 'open', 'open']);
    expect(task.keepBranch('git@github.com:me/web.git', 'feat/a')).toBe('feat/c');
    expect(raw(task).repos).toEqual([{
      url: 'git@github.com:me/web.git', branch: 'feat/a', earlierBranches: ['feat/b', 'feat/c'],
      branchMarks: { 'feat/b': 'open', 'feat/c': 'open', 'feat/a': 'open' },
    }]);
  });

  it('marks one given up, where it stands, and opens it again when the work moves back to it', () => {
    const task = Task.create('x', [{ url: 'git@github.com:me/web.git' }]);
    task.keepBranch('git@github.com:me/web.git', 'feat/a');
    task.keepBranch('git@github.com:me/web.git', 'feat/b');
    expect(task.abandonBranch('git@github.com:me/web.git', 'feat/a')).toBe(true);
    expect(task.abandonBranch('https://github.com/me/web', 'feat/a'), 'given up already').toBe(false);
    const repo = task.read().repos[0] as TaskRepo;
    expect(repo).toMatchObject({ branch: 'feat/b', earlierBranches: ['feat/a'] });
    expect([branchMark(repo, 'feat/a'), branchMark(repo, 'feat/b')]).toEqual(['abandoned', 'open']);

    task.keepBranch('git@github.com:me/web.git', 'feat/a');
    expect(branchMark(task.read().repos[0] as TaskRepo, 'feat/a')).toBe('open');

    expect(() => task.abandonBranch('git@github.com:me/web.git', 'feat/z')).toThrow(/feat\/z is not a branch of this task in git@github.com:me\/web.git - it has kept feat\/a, feat\/b/);
    expect(() => task.abandonBranch('git@github.com:me/api.git', 'feat/a')).toThrow(/not a repository of this task/);
  });

  it('notes where a branch last met the default branch, keeps it when the worktree moves on, and reads only full shas of its branches', () => {
    const [a, b] = ['a'.repeat(40), 'b'.repeat(40)];
    const task = Task.create('x', [{ url: 'git@github.com:me/web.git' }]);
    task.keepBranch('git@github.com:me/web.git', 'feat/a');
    expect(task.noteBranchBase('git@github.com:me/web.git', 'feat/a', a)).toBe(true);
    expect(task.noteBranchBase('https://github.com/me/web', 'feat/a', a), 'noted already').toBe(false);
    task.keepBranch('git@github.com:me/web.git', 'feat/b');
    task.noteBranchBase('git@github.com:me/web.git', 'feat/b', b);
    expect(task.read().repos[0]?.branchBases).toEqual({ 'feat/a': a, 'feat/b': b });

    expect(() => task.noteBranchBase('git@github.com:me/web.git', 'feat/z', a)).toThrow(/feat\/z is not a branch of this task/);
    expect(() => task.noteBranchBase('git@github.com:me/web.git', 'feat/a', 'abc1234')).toThrow(/not a full commit sha/);

    writeFileSync(task.file, JSON.stringify({ ...raw(task), repos: [{ ...(raw(task).repos as Record<string, unknown>[])[0], branchBases: { 'feat/a': a, 'feat/b': 'HEAD~1', gone: b } }] }));
    expect(task.read().repos[0]?.branchBases, 'a ref edited in, and a branch not kept, are left out').toEqual({ 'feat/a': a });
  });

  it('reads a branch a yan from before marks kept: open the last the worktree was on, given up the earlier ones', () => {
    const task = Task.create('x', [{ url: 'git@github.com:me/web.git' }]);
    writeFileSync(task.file, JSON.stringify({ ...raw(task), repos: [{ url: 'git@github.com:me/web.git', branch: 'c', earlierBranches: ['a', 'b'] }] }));
    const old = task.read().repos[0] as TaskRepo;
    expect(['a', 'b', 'c'].map((b) => branchMark(old, b))).toEqual(['abandoned', 'abandoned', 'open']);

    task.keepBranch('git@github.com:me/web.git', 'd');
    const now = task.read().repos[0] as TaskRepo;
    expect(['a', 'b', 'c', 'd'].map((b) => branchMark(now, b)), 'the one the worktree left stays open').toEqual(['abandoned', 'abandoned', 'open', 'open']);
    expect((raw(task).repos as Record<string, unknown>[])[0]?.branchMarks).toEqual({ c: 'open', d: 'open' });
  });

  it('reads only the marks of branches it keeps, and only the marks it knows', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ ...raw(task), repos: [{ url: 'git@github.com:me/web.git', branch: 'b', earlierBranches: ['a', 'b'], branchMarks: { a: 'abandoned', b: 'merged', z: 'open' } }] }));
    expect(task.read().repos[0]).toEqual({ url: 'git@github.com:me/web.git', branch: 'b', earlierBranches: ['a'], branchMarks: { a: 'abandoned' } });
  });

  it('reads the earlier branches as names, once each, whatever was edited in', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ ...raw(task), repos: [{ url: 'git@github.com:me/web.git', branch: 'c', earlierBranches: ['a', ' a ', 'two words', 3, '', 'b'] }] }));
    expect(task.read().repos[0]?.earlierBranches).toEqual(['a', 'b']);
  });

  it('keeps one for a task from before it could have several repositories', () => {
    const task = Task.create('x');
    writeFileSync(task.file, JSON.stringify({ ...raw(task), repo: 'git@github.com:me/repo.git', scope: ['packages/a'] }));
    task.keepBranch('git@github.com:me/repo.git', 'feat/a');
    expect(task.read().repos).toEqual([{ url: 'git@github.com:me/repo.git', scope: ['packages/a'], branch: 'feat/a', branchMarks: { 'feat/a': 'open' } }]);
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

  it('closes a task waiting to be accepted', () => {
    const task = Task.create('x');
    task.awaitUat();
    task.close('done');
    expect(task.read().state).toBe('done');
  });
});

describe('uat', () => {
  it('waits to be accepted, and says so again harmlessly', () => {
    const task = Task.create('x');
    task.awaitUat();
    expect(task.read().state).toBe('uat');
    task.awaitUat();
    expect(task.read().state).toBe('uat');
  });

  it('refuses on a closed task', () => {
    const task = Task.create('x');
    task.close('done');
    expect(() => task.awaitUat()).toThrow(/done already/);
    expect(task.read().state).toBe('done');
  });
});
