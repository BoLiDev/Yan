import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, repoRoot } from '../helpers/fixtures.js';

/**
 * Phase 1's four other ported commands: `open`, `drain`, `scope-check` and
 * `repo-add`. They are exercised through `bin/yan`, so what is under test is
 * the whole path a person or an agent actually takes — the dispatcher choosing
 * the ported half included.
 *
 * Phase 1 Trace: "scope-check reports and never blocks."
 */

afterAll(cleanupTempDirs);

let home = '';
let previousHome: string | undefined;

function yan(args: readonly string[], env: Record<string, string> = {}) {
  const merged = { ...process.env, YAN_HOME: home, ...env };
  const r = spawnSync('bash', [join(home, 'bin', 'yan'), ...args], {
    encoding: 'utf8',
    env: merged,
    windowsHide: true,
  });
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function fxGit(args: readonly string[], cwd: string) {
  const r = spawnSync(
    'git',
    [
      '-c',
      'user.name=yan tests',
      '-c',
      'user.email=yan-tests@localhost',
      '-c',
      'init.defaultBranch=main',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

beforeEach(async () => {
  previousHome = process.env.YAN_HOME;
  home = mkYanHome(mkTempDir(), { withDist: true });
  process.env.YAN_HOME = home;
  const store = await import('../../src/store/task.js');
  store.taskInit('t042', 'unify the auth header');
  store.unitAdd('t042', 'auth', 'monorepo-x', 'master', {
    branch: 'feat/auth',
    scope: ['apps/auth'],
  });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previousHome;
});

describe('yan open', () => {
  it('always prints the absolute path and exits 0', () => {
    const r = yan(['open', 't042'], { YAN_OPENER: '' });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout.trim().endsWith('tasks/t042')).toBe(true);
  });

  it('creates artifacts/ so there is something to open', () => {
    const r = yan(['open', 't042', '--artifacts'], { YAN_OPENER: '' });
    expect(r.code).toBe(0);
    expect(existsSync(join(home, 'tasks', 't042', 'artifacts'))).toBe(true);
  });

  it('uses $YAN_OPENER when one is set, and still exits 0 if it fails', () => {
    const record = join(mkTempDir(), 'opened');
    const opener = join(home, 'opener.sh');
    writeFileSync(opener, `#!/usr/bin/env bash\nprintf '%s\\n' "$1" > "${record}"\nexit 1\n`);
    const r = yan(['open', 't042'], { YAN_OPENER: `bash ${opener}` });
    // The opener's exit code must never become this command's.
    expect(r.code).toBe(0);
  });

  it('refuses an unknown task and a missing argument', () => {
    expect(yan(['open', 'nope']).code).not.toBe(0);
    expect(yan(['open']).code).toBe(2);
  });
});

describe('yan drain', () => {
  const wakeFile = (): string => join(home, 'tasks', 't042', 'run', 'wake');

  it('is silent and exits 0 when there is nothing to drain', () => {
    const r = yan(['drain', 't042']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('');
  });

  it('reads first and clears second', () => {
    mkdirSync(join(home, 'tasks', 't042', 'run'), { recursive: true });
    writeFileSync(wakeFile(), 'blocked: s1\n');

    const r = yan(['drain', 't042']);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('blocked: s1\n');
    expect(existsSync(wakeFile())).toBe(false);
  });

  it('--peek leaves the reason in place', () => {
    mkdirSync(join(home, 'tasks', 't042', 'run'), { recursive: true });
    writeFileSync(wakeFile(), 'done: s2\n');

    expect(yan(['drain', 't042', '--peek']).stdout).toBe('done: s2\n');
    expect(existsSync(wakeFile())).toBe(true);
  });

  it('takes the task from $YAN_TASK, and $YAN_WAKE_FILE overrides the path', () => {
    mkdirSync(join(home, 'tasks', 't042', 'run'), { recursive: true });
    writeFileSync(wakeFile(), 'from YAN_TASK\n');
    expect(yan(['drain'], { YAN_TASK: 't042' }).stdout).toBe('from YAN_TASK\n');

    const elsewhere = join(mkTempDir(), 'wake');
    writeFileSync(elsewhere, 'from YAN_WAKE_FILE\n');
    expect(yan(['drain'], { YAN_WAKE_FILE: elsewhere }).stdout).toBe('from YAN_WAKE_FILE\n');
  });

  it('refuses when it cannot tell whose wake file to drain', () => {
    const r = yan(['drain'], { YAN_TASK: '' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('cannot tell whose wake file');
  });
});

describe('yan scope-check', () => {
  /** A real git worktree with the unit's branch, held by a fake live shift. */
  function seedShift(sid: string): string {
    const tree = mkTempDir('yan-tree-');
    expect(fxGit(['init', '--initial-branch=feat/auth', '.'], tree).code).toBe(0);
    mkdirSync(join(tree, 'apps', 'auth'), { recursive: true });
    writeFileSync(join(tree, 'apps', 'auth', 'header.ts'), 'export const a = 1;\n');
    expect(fxGit(['add', '.'], tree).code).toBe(0);
    expect(fxGit(['commit', '-m', 'seed'], tree).code).toBe(0);

    const run = join(home, 'tasks', 't042', 'shifts', sid, 'run');
    mkdirSync(run, { recursive: true });
    writeFileSync(
      join(run, 'meta.json'),
      `${JSON.stringify({ version: 1, unit: 'auth', branch: `yan/${sid}`, tree }, null, 2)}\n`,
    );
    return tree;
  }

  it('reports out-of-scope paths and still exits 0', () => {
    const tree = seedShift('s1');
    // One edit inside the scope, one outside it.
    writeFileSync(join(tree, 'apps', 'auth', 'header.ts'), 'export const a = 2;\n');
    mkdirSync(join(tree, 'apps', 'common'), { recursive: true });
    writeFileSync(join(tree, 'apps', 'common', 'types.ts'), 'export type T = 1;\n');

    const r = yan(['scope-check', 's1', '--task', 't042']);
    expect(r.code, r.stderr).toBe(0); // <- reports, never blocks
    expect(r.stdout).toContain('out of scope');
    expect(r.stdout).toContain('apps/common/types.ts');
    expect(r.stdout).toContain('This is a report, not a refusal.');
  });

  it('sees an untracked file, which git diff alone would not', () => {
    const tree = seedShift('s2');
    mkdirSync(join(tree, 'apps', 'other'), { recursive: true });
    writeFileSync(join(tree, 'apps', 'other', 'stray.ts'), '// stray\n');

    const r = yan(['scope-check', 's2', '--task', 't042', '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as { out_of_scope: string[]; blocked: boolean };
    expect(json.out_of_scope).toContain('apps/other/stray.ts');
    expect(json.blocked).toBe(false);
  });

  it('exits 0 with nothing outside when every change is in scope', () => {
    const tree = seedShift('s3');
    writeFileSync(join(tree, 'apps', 'auth', 'header.ts'), 'export const a = 3;\n');

    const r = yan(['scope-check', 's3', '--task', 't042', '--json']);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout) as { in_scope: string[]; out_of_scope: string[] };
    expect(json.out_of_scope).toEqual([]);
    expect(json.in_scope).toContain('apps/auth/header.ts');
  });

  it('fails only for reasons that are really failures', () => {
    // No such shift, and a shift whose meta records no tree.
    expect(yan(['scope-check', 'nosuch', '--task', 't042']).code).not.toBe(0);

    const run = join(home, 'tasks', 't042', 'shifts', 's9', 'run');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'meta.json'), '{"version":1,"unit":"auth"}\n');
    const r = yan(['scope-check', 's9', '--task', 't042']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('records no tree');
  });
});

describe('yan repo-add', () => {
  function bareRemote(): string {
    const bare = join(mkTempDir(), 'origin.git');
    expect(fxGit(['init', '--bare', '--initial-branch=main', bare], repoRoot).code).toBe(0);
    const seed = mkTempDir('yan-seed-');
    fxGit(['init', '--initial-branch=main', '.'], seed);
    writeFileSync(join(seed, 'README.md'), 'fixture\n');
    fxGit(['add', '.'], seed);
    fxGit(['commit', '-m', 'initial'], seed);
    fxGit(['remote', 'add', 'origin', bare], seed);
    fxGit(['push', '-u', 'origin', 'main'], seed);
    return bare;
  }

  it('clones once, registers the defaults, and is idempotent', () => {
    const url = bareRemote();
    const first = yan(['repo-add', url, '--name', 'monorepo-x']);
    expect(first.code, first.stderr).toBe(0);
    expect(existsSync(join(home, 'repos', 'monorepo-x', '.git'))).toBe(true);

    const registry = JSON.parse(readFileSync(join(home, 'mem', 'repos.json'), 'utf8')) as Record<
      string,
      { mode_default: string; pool_size: number }
    >;
    expect(registry['monorepo-x']?.mode_default).toBe('mr');
    expect(registry['monorepo-x']?.pool_size).toBe(8);

    const second = yan(['repo-add', url, '--name', 'monorepo-x']);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain('already exists, keeping it (no re-clone)');
  });

  it('never clobbers a tuned setting, and an explicit flag does', () => {
    const url = bareRemote();
    yan(['repo-add', url, '--name', 'r1', '--pool-size', '3', '--mode-default', 'branch']);
    yan(['repo-add', url, '--name', 'r1']);

    const registry = JSON.parse(readFileSync(join(home, 'mem', 'repos.json'), 'utf8')) as Record<
      string,
      { mode_default: string; pool_size: number }
    >;
    expect(registry.r1?.pool_size).toBe(3);
    expect(registry.r1?.mode_default).toBe('branch');
  });

  it('refuses a second URL under a name that is already taken', () => {
    const url = bareRemote();
    yan(['repo-add', url, '--name', 'r1']);
    const r = yan(['repo-add', 'https://example.invalid/other.git', '--name', 'r1']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('already registered');
  });

  it('refuses the reserved name and an unusable one', () => {
    expect(yan(['repo-add', 'https://example.invalid/x.git', '--name', 'version']).code).toBe(2);
    expect(yan(['repo-add', 'https://example.invalid/x.git', '--name', 'has space']).code).toBe(2);
    expect(yan(['repo-add']).code).toBe(2);
  });

  it('derives a name from every URL spelling a forge hands out', async () => {
    const { repoNameFromUrl } = await import('../../src/cli/repo-add.js');
    expect(repoNameFromUrl('git@host:org/name.git')).toBe('name');
    expect(repoNameFromUrl('ssh://git@host:22/org/name.git')).toBe('name');
    expect(repoNameFromUrl('https://host/org/name.git')).toBe('name');
    expect(repoNameFromUrl('https://host/org/name/')).toBe('name');
    expect(repoNameFromUrl('git@host:name')).toBe('name');
  });
});
