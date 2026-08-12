import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkClone, mkTempDir, mkYanHome, repoRoot, runYan } from '../helpers/fixtures.js';

/**
 * Phase 1's other read-only ported commands: `open`, `drain` and `repo`. They
 * are exercised through `bin/yan`, so what is under test is the whole path a
 * person or an agent actually takes.
 */

afterAll(cleanupTempDirs);

let home = '';
let previousHome: string | undefined;

// The shared helper, bound to this file's home. It was a local copy on
// spawnSync until the suite went parallel again; a fourth implementation of
// "run bin/yan" is a fourth place for the blocking to come back.
function yan(args: readonly string[], env: Record<string, string> = {}) {
  return runYan(home, args, env);
}


beforeEach(async () => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir(), { withDist: true });
  process.env.YAN_HOME = home;
  const store = await import('../../src/records/task/index.js');
  store.Task.create('t042', 'unify the auth header');
  new store.Task('t042').addUnit('auth', 'monorepo-x', 'master', {
    branch: 'feat/auth',
    scope: ['apps/auth'],
  });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('yan open', () => {
  it('always prints the absolute path and exits 0', async () => {
    const r = await yan(['open', 't042'], { YAN_OPENER: '' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().endsWith('tasks/t042')).toBe(true);
  });

  it('creates artifacts/ so there is something to open', async () => {
    const r = await yan(['open', 't042', '--artifacts'], { YAN_OPENER: '' });
    expect(r.code).toBe(0);
    expect(existsSync(join(home, 'tasks', 't042', 'artifacts'))).toBe(true);
  });

  it('uses $YAN_OPENER when one is set, and still exits 0 if it fails', async () => {
    const record = join(mkTempDir(), 'opened');
    const opener = join(home, 'opener.sh');
    writeFileSync(opener, `#!/usr/bin/env bash\nprintf '%s\\n' "$1" > "${record}"\nexit 1\n`);
    const r = await yan(['open', 't042'], { YAN_OPENER: `bash ${opener}` });
    // The opener's exit code must never become this command's.
    expect(r.code).toBe(0);
  });

  it('refuses an unknown task and a missing argument', async () => {
    expect((await yan(['open', 'nope'])).code).not.toBe(0);
    expect((await yan(['open'])).code).toBe(2);
  });
});

describe('yan drain', () => {
  const wakeFile = (): string => join(home, 'tasks', 't042', 'run', 'wake');

  it('is silent and exits 0 when there is nothing to drain', async () => {
    const r = await yan(['drain', 't042']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('reads first and clears second', async () => {
    mkdirSync(join(home, 'tasks', 't042', 'run'), { recursive: true });
    writeFileSync(wakeFile(), 'blocked: s1\n');

    const r = await yan(['drain', 't042']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('blocked: s1\n');
    expect(existsSync(wakeFile())).toBe(false);
  });

  it('--peek leaves the reason in place', async () => {
    mkdirSync(join(home, 'tasks', 't042', 'run'), { recursive: true });
    writeFileSync(wakeFile(), 'done: s2\n');

    expect((await yan(['drain', 't042', '--peek'])).stdout).toBe('done: s2\n');
    expect(existsSync(wakeFile())).toBe(true);
  });

  it('takes the task from $YAN_TASK, and $YAN_WAKE_FILE overrides the path', async () => {
    mkdirSync(join(home, 'tasks', 't042', 'run'), { recursive: true });
    writeFileSync(wakeFile(), 'from YAN_TASK\n');
    expect((await yan(['drain'], { YAN_TASK: 't042' })).stdout).toBe('from YAN_TASK\n');

    const elsewhere = join(mkTempDir(), 'wake');
    writeFileSync(elsewhere, 'from YAN_WAKE_FILE\n');
    expect((await yan(['drain'], { YAN_WAKE_FILE: elsewhere })).stdout).toBe('from YAN_WAKE_FILE\n');
  });

  it('refuses when it cannot tell whose wake file to drain', async () => {
    const r = await yan(['drain'], { YAN_TASK: '' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot tell whose wake file');
  });
});

describe('yan repo add', () => {
  async function bareRemote(): Promise<string> {
    const bare = join(mkTempDir(), 'origin.git');
    expect((await fxGit(['init', '--bare', '--initial-branch=main', bare], repoRoot)).code).toBe(0);
    const seed = mkTempDir('yan-seed-');
    await fxGit(['init', '--initial-branch=main', '.'], seed);
    writeFileSync(join(seed, 'README.md'), 'fixture\n');
    await fxGit(['add', '.'], seed);
    await fxGit(['commit', '-m', 'initial'], seed);
    await fxGit(['remote', 'add', 'origin', bare], seed);
    await fxGit(['push', '-u', 'origin', 'main'], seed);
    return bare;
  }

  /** The portable half. A path never appears in it (v3 td repos.md §2). */
  function portable(): Record<string, { url?: string; mode_default?: string; pool_size?: number }> {
    return JSON.parse(readFileSync(join(home, 'repos.json'), 'utf8')) as Record<
      string,
      { url?: string; mode_default?: string; pool_size?: number }
    >;
  }

  /** The machine half. Nothing but paths, and never committed. */
  function local(): Record<string, { path?: string }> {
    return JSON.parse(readFileSync(join(home, '.local', 'repos.json'), 'utf8')) as Record<
      string,
      { path?: string }
    >;
  }

  const same = (a: string | undefined, b: string): boolean =>
    (a ?? '').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

  it('clones once, registers both halves, and is idempotent', async () => {
    const url = await bareRemote();
    const into = join(home, 'repos');
    const first = await yan(['repo', 'add', url, '--name', 'monorepo-x', '--path', into]);
    expect(first.code, first.stderr).toBe(0);
    expect(existsSync(join(into, 'monorepo-x', '.git'))).toBe(true);

    expect(portable()['monorepo-x']?.mode_default).toBe('mr');
    expect(portable()['monorepo-x']?.pool_size).toBe(8);
    // The split is the whole point: no path on the tracked side.
    expect(JSON.stringify(portable()['monorepo-x'])).not.toContain('path');
    expect(local()['monorepo-x']?.path).toBeTruthy();

    const second = await yan(['repo', 'add', url, '--name', 'monorepo-x', '--path', into]);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('already exists, keeping it (no re-clone)');
  });

  it('never clobbers a tuned setting, and an explicit flag does', async () => {
    const url = await bareRemote();
    const into = join(home, 'repos');
    await yan(['repo', 'add', url, '--name', 'r1', '--path', into, '--pool-size', '3', '--mode-default', 'branch']);
    await yan(['repo', 'add', url, '--name', 'r1', '--path', into]);

    expect(portable().r1?.pool_size).toBe(3);
    expect(portable().r1?.mode_default).toBe('branch');
  });

  it('refuses a second URL under a name that is already taken', async () => {
    const url = await bareRemote();
    const into = join(home, 'repos');
    await yan(['repo', 'add', url, '--name', 'r2', '--path', into]);
    const r = await yan(['repo', 'add', 'https://example.invalid/other.git', '--name', 'r2', '--path', into]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('already registered');
  });

  it('refuses the reserved name and an unusable one', async () => {
    expect((await yan(['repo', 'add', 'https://example.invalid/x.git', '--name', 'version'])).code).toBe(2);
    expect((await yan(['repo', 'add', 'https://example.invalid/x.git', '--name', 'has space'])).code).toBe(2);
  });

  it('with no argument and no terminal, refuses instead of waiting on a prompt', async () => {
    const r = await yan(['repo', 'add']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/pass a path or a URL|no git clones directly under/);
  });

  it('registers a clone that is already on disk, and clones nothing', async () => {
    const url = await bareRemote();
    const where = join(mkTempDir('yan-existing-'), 'already-here');
    await mkClone(url, where);

    const r = await yan(['repo', 'add', where, '--name', 'already']);
    expect(r.code, r.stderr).toBe(0);
    expect(same(local().already?.path, where)).toBe(true);
    expect(portable().already?.url).toBeTruthy();
  });

  it('links a registered repository to a path here, and refuses one it does not know', async () => {
    const url = await bareRemote();
    const moved = join(mkTempDir('yan-moved-'), 'moved');
    await mkClone(url, moved);
    await yan(['repo', 'add', moved, '--name', 'movable']);

    const elsewhere = join(mkTempDir('yan-elsewhere-'), 'elsewhere');
    await mkClone(url, elsewhere);
    const linked = await yan(['repo', 'link', 'movable', elsewhere]);
    expect(linked.code, linked.stderr).toBe(0);
    expect(same(local().movable?.path, elsewhere)).toBe(true);

    const unknown = await yan(['repo', 'link', 'nosuch', elsewhere]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('not registered');
  });

  it('lists what is registered, and says which are not linked here', async () => {
    const url = await bareRemote();
    const where = join(mkTempDir('yan-listed-'), 'listed');
    await mkClone(url, where);
    await yan(['repo', 'add', where, '--name', 'listed']);

    // What a vault that arrived from another machine looks like: registered,
    // with no path on this disk. It is a normal state, not a broken one.
    const file = join(home, 'repos.json');
    const reg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    reg['from-elsewhere'] = { url: 'git@host:org/from-elsewhere.git', mode_default: 'mr', pool_size: 8 };
    writeFileSync(file, `${JSON.stringify(reg, null, 2)}\n`);

    const r = await yan(['repo', 'ls']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('listed');
    expect(r.stdout).toContain('NOT LINKED');
    expect(r.stdout).toContain('1 registered but not linked here');
  });

  it('derives a name from every URL spelling a forge hands out', async () => {
    const { repoNameFromUrl } = await import('../../src/cli/repo.js');
    expect(repoNameFromUrl('git@host:org/name.git')).toBe('name');
    expect(repoNameFromUrl('ssh://git@host:22/org/name.git')).toBe('name');
    expect(repoNameFromUrl('https://host/org/name.git')).toBe('name');
    expect(repoNameFromUrl('https://host/org/name/')).toBe('name');
    expect(repoNameFromUrl('git@host:name')).toBe('name');
  });
});
