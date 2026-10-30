import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkTempDir } from '../../../tests/helpers/fixtures.js';
import { hiddenBy, parseLog, readTaskJson, VaultView } from './vault-view.js';

/**
 * The vault as `yan serve` reads it, from git objects: what each task holds,
 * when each artifact arrived, and the pushes Latest lists.
 */

afterAll(cleanupTempDirs);

describe('what the tree leaves out', () => {
  it('hides dotfiles, installed packages and browser profiles, and nothing else', () => {
    expect(hiddenBy('c4/shot.png')).toBeUndefined();
    expect(hiddenBy('.DS_Store')).toBe('.DS_Store');
    expect(hiddenBy('run/.cache/x.json')).toBe('.cache');
    expect(hiddenBy('tool/node_modules/a/index.js')).toBe('node_modules');
    expect(hiddenBy('check/chrome-profile/Default/Cookies')).toBe('chrome-profile');
    expect(hiddenBy('check/chrome-prof/x')).toBe('chrome-prof');
    expect(hiddenBy('profile-notes.md')).toBeUndefined();
  });
});

describe('the log', () => {
  it('reads each line as a day, a type and its words, and carries a stray line on the one before', () => {
    expect(parseLog('- 10-15  agreed   one thing\n- 10-16  changed  another\nmore of it\n\n- 10-16  paused   stop\n')).toEqual([
      { day: '10-15', type: 'agreed', text: 'one thing' },
      { day: '10-16', type: 'changed', text: 'another\nmore of it' },
      { day: '10-16', type: 'paused', text: 'stop' },
    ]);
  });
});

describe('task.json', () => {
  it('reads what it can of any shape and names each repository', () => {
    expect(readTaskJson({ title: 'x', repos: [{ url: 'git@github.com:o/web.git', branch: 'yan/t1-c', earlierBranches: ['yan/t1-a', 'yan/t1-b', 'yan/t1-a', 4] }, { nope: 1 }], deliverables: [{ id: 'd1', text: 't', status: 'done', doneAt: '2026-10-15' }], resources: { a: 'b', n: 3 }, resourceKinds: { a: 'run', n: 4 } })).toEqual({
      title: 'x',
      state: 'open',
      createdAt: null,
      closedAt: null,
      reason: null,
      repos: [{ url: 'git@github.com:o/web.git', name: 'web', branch: 'yan/t1-c', earlier: ['yan/t1-a', 'yan/t1-b'], abandoned: ['yan/t1-a', 'yan/t1-b'], bases: {} }],
      deliverables: [{ id: 'd1', text: 't', status: 'done', doneAt: '2026-10-15', reason: null }],
      resources: [['a', 'b'], ['n', '3']],
      resourceKinds: { a: 'run' },
    });
    expect(readTaskJson('not an object').title).toBe('');
  });

  it('names the branches the task marks given up, and reads the earlier ones of a yan from before marks as given up', () => {
    const repos = readTaskJson({ repos: [
      { url: 'git@github.com:o/web.git', branch: 'c', earlierBranches: ['a', 'b'], branchMarks: { a: 'open', b: 'abandoned', c: 'open' } },
      { url: 'git@github.com:o/api.git', branch: 'y', earlierBranches: ['x'] },
    ] }).repos;
    expect(repos.map((r) => r.abandoned)).toEqual([['b'], ['x']]);
  });

  it('reads where each branch last met the default branch, only as a full commit sha', () => {
    const sha = 'c'.repeat(40);
    const [repo] = readTaskJson({ repos: [{ url: 'git@github.com:o/web.git', branch: 'c', branchBases: { c: sha, d: 'main; rm -rf', e: 4 } }] }).repos;
    expect(repo?.bases).toEqual({ c: sha });
  });
});

describe('a vault at a commit', () => {
  const T = 1_790_000_000;
  let dir = '';
  const commits: string[] = [];

  async function commitAt(at: number, files: Record<string, string>, message: string, removed: readonly string[] = []): Promise<void> {
    for (const rel of removed) await fxGit(['rm', '-q', '--', rel], dir);
    for (const [rel, body] of Object.entries(files)) {
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      writeFileSync(join(dir, rel), body);
      await fxGit(['add', '--', rel], dir);
    }
    process.env.GIT_COMMITTER_DATE = `${at} +0000`;
    process.env.GIT_AUTHOR_DATE = `${at} +0000`;
    try {
      await fxGit(['commit', '-q', '-m', message], dir);
    } finally {
      delete process.env.GIT_COMMITTER_DATE;
      delete process.env.GIT_AUTHOR_DATE;
    }
    commits.push((await fxGit(['rev-parse', 'HEAD'], dir)).stdout.trim());
  }

  beforeAll(async () => {
    dir = mkTempDir('yan-serve-vault-');
    await fxGit(['init', '-q', '--initial-branch=main', dir]);
    const task = (id: string, title: string, resources = {}, resourceKinds = {}): string => JSON.stringify({ version: 2, id, title, state: 'open', repos: [], nextDeliverable: 1, deliverables: [], resources, resourceKinds });
    await commitAt(T, {
      'tasks/t001/task.json': task('t001', 'one'),
      'tasks/t001/problem.md': '# one\n\nWhy.\n',
      'tasks/t001/log.md': '- 09-21  agreed   go\n',
      'tasks/t001/artifacts/c4/a.png': 'png one',
      'tasks/t001/artifacts/node_modules/x/index.js': 'x',
      'tasks/t001/artifacts/.cache': 'c',
    }, 't001');
    await commitAt(T + 5 * 60, { 'tasks/t001/artifacts/b.md': '# b' }, 't001 b');
    await commitAt(T + 60 * 60, {
      'tasks/t002/task.json': task('t002', 'two', { cloud: 'https://agent.example/t/2', note: 'ran it by hand', spec: 'https://tracker.example/2' }, { cloud: 'run', note: 'run', spec: 'spec' }),
      'tasks/t002/artifacts/c.txt': 'c',
    }, 't002');
    await commitAt(T + 61 * 60, { 'tasks/t001/artifacts/c4/a.png': 'png two' }, 't001 again');
    await commitAt(T + 180 * 60, { 'tasks/t001/artifacts/scratch.txt': 's' }, 't001 scratch', ['tasks/t001/artifacts/b.md']);
    await commitAt(T + 181 * 60, {}, 't001 tidy', ['tasks/t001/artifacts/scratch.txt']);
  });

  it('lists every task with when its artifacts arrived, newest first', async () => {
    const view = new VaultView(dir);
    try {
      await view.load(commits[3] as string);
      const { tasks } = view.index();
      expect(tasks.map((t) => [t.id, t.title, t.artifacts, t.added, t.touched])).toEqual([
        ['t001', 'one', 2, [T + 5 * 60, T], T + 61 * 60],
        ['t002', 'two', 1, [T + 60 * 60], T + 60 * 60],
      ]);
      expect(tasks.map((t) => t.agents), 'a run that is a web link, and nothing else').toEqual([[], [['cloud', 'https://agent.example/t/2']]]);
    } finally {
      await view.close();
    }
  });

  it('gives each task a rev that moves when its own files do, and only then', async () => {
    const view = new VaultView(dir);
    try {
      const revs = async (at: number): Promise<Record<string, string>> => {
        await view.load(commits[at] as string);
        return Object.fromEntries(view.index().tasks.map((t) => [t.id, t.rev]));
      };
      const two = await revs(2);
      const three = await revs(3);
      expect(three.t001, 't001 changed a file').not.toBe(two.t001);
      expect(three.t002, 't002 did not').toBe(two.t002);
      expect(three.t001).not.toBe(three.t002);
    } finally {
      await view.close();
    }
  });

  it('runs commits in a row on one task, close together, into one push, and keeps a file there once', async () => {
    const view = new VaultView(dir);
    try {
      await view.load(commits[3] as string);
      const pushes = view.index().latest.map((p) => [p.task, p.at, p.files.map((f) => `${f.status} ${f.path}`)]);
      expect(pushes).toEqual([
        ['t001', T + 61 * 60, ['M c4/a.png']],
        ['t002', T + 60 * 60, ['A c.txt']],
        ['t001', T + 5 * 60, ['A b.md', 'A c4/a.png']],
      ]);
      // Each file keeps when it last changed, not when its push ended: a file looked at early in a push stays seen.
      expect(view.index().latest[2]?.files.map((f) => [f.path, f.at])).toEqual([['b.md', T + 5 * 60], ['c4/a.png', T]]);
    } finally {
      await view.close();
    }
  });

  it('lists a file deleted in a push as deleted, and one added and deleted in the same push not at all', async () => {
    const view = new VaultView(dir);
    try {
      await view.load(commits[5] as string);
      expect(view.index().latest[0]).toEqual({ task: 't001', at: T + 181 * 60, files: [{ path: 'b.md', sha: '', status: 'D', at: T + 180 * 60 }] });
    } finally {
      await view.close();
    }
  });

  it('gives a task its problem, log and shown files, and counts what it hides', async () => {
    const view = new VaultView(dir);
    try {
      await view.load(commits[3] as string);
      const t = await view.task('t001');
      expect(t?.problem?.text).toBe('# one\n\nWhy.\n');
      expect(t?.log?.entries).toEqual([{ day: '09-21', type: 'agreed', text: 'go' }]);
      expect(t?.files.map((f) => [f.path, f.added, f.changed, f.commit])).toEqual([
        ['b.md', T + 5 * 60, T + 5 * 60, commits[1]],
        ['c4/a.png', T, T + 61 * 60, commits[3]],
      ]);
      expect(t?.hidden).toEqual([{ name: '.cache', count: 1 }, { name: 'node_modules', count: 1 }]);
      const png = t?.files.find((f) => f.path === 'c4/a.png');
      expect((await view.blobs.read(png?.sha ?? ''))?.toString()).toBe('png two');
      expect(await view.task('t404')).toBeUndefined();
    } finally {
      await view.close();
    }
  });

  it('reads only the new history when it moves forward, and ends where a fresh read does', async () => {
    const fresh = new VaultView(dir);
    const moved = new VaultView(dir);
    try {
      await fresh.load(commits[3] as string);
      await moved.load(commits[1] as string);
      expect(moved.index().tasks.map((t) => t.id)).toEqual(['t001']);
      await moved.load(commits[3] as string);
      expect(moved.index()).toEqual(fresh.index());
      expect(await moved.task('t001')).toEqual(await fresh.task('t001'));
    } finally {
      await fresh.close();
      await moved.close();
    }
  });
});
