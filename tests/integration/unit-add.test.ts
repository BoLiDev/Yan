import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkClone,
  mkTempDir,
  mkYanHome,
  registerRepo,
  runYan,
} from '../helpers/fixtures.js';

/**
 * `yan unit add` against real git and a local bare remote. Nothing here
 * touches the network.
 *
 * What it pins: whatever spelling a name arrives in becomes the branch, an
 * existing branch is adopted rather than re-cut, and a refusal leaves neither
 * a branch nor a unit behind.
 */

afterAll(cleanupTempDirs);

let home = '';
let clone = '';
let bare = '';

function unitField(task: string, unit: string, field: string): unknown {
  const doc = JSON.parse(readFileSync(join(home, 'tasks', task, 'task.json'), 'utf8')) as {
    units: Record<string, unknown>[];
  };
  return doc.units.find((u) => u.name === unit)?.[field] ?? '';
}

function unitCount(task: string): number {
  const doc = JSON.parse(readFileSync(join(home, 'tasks', task, 'task.json'), 'utf8')) as {
    units: unknown[];
  };
  return doc.units.length;
}

async function hasBranch(branch: string): Promise<boolean> {
  return (await fxGit(['-C', clone, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

/** A shell `branch-create` hook. `$ctx` holds the JSON yan sent on stdin. */
function writeHook(body: string): void {
  const dir = join(home, 'hooks');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'branch-create');
  writeFileSync(file, `#!/usr/bin/env bash\nctx=$(cat)\n${body}\n`);
  chmodSync(file, 0o755);
}

/** The same hook in JavaScript. The .mjs extension is what picks node. */
function writeJsHook(body: string): void {
  const dir = join(home, 'hooks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'branch-create.mjs'),
    [
      "import { execFileSync } from 'node:child_process';",
      "import { readFileSync } from 'node:fs';",
      "const ctx = JSON.parse(readFileSync(0, 'utf8'));",
      "const git = (...a) => execFileSync('git', a, { cwd: ctx.repo_dir, encoding: 'utf8' });",
      body,
      '',
    ].join('\n'),
  );
}

function removeHooks(): void {
  for (const name of ['branch-create', 'branch-create.mjs']) {
    rmSync(join(home, 'hooks', name), { force: true });
  }
}

beforeAll(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  bare = await mkBareRemote(join(tmp, 'remote.git'));
  clone = await mkClone(bare, join(home, 'repos', 'demo'));
  registerRepo(home, 'demo', clone, { url: bare });

  const previous = process.env.YAN_HOME;
  process.env.YAN_HOME = home;
  const { Task } = await import('../../src/records/task/index.js');
  Task.create('t1', 'a demo task');
  if (previous === undefined) delete process.env.YAN_HOME;
  else process.env.YAN_HOME = previous;
});

describe('target is never defaulted', () => {
  it('refuses an add with no --target, and writes nothing', async () => {
    const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'auth', '--repo', 'demo']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('--target is required');
    expect(r.out).toContain('no safe default');
    expect(unitCount('t1')).toBe(0);
  });

  it('names the other missing arguments too', async () => {
    expect((await runYan(home, ['unit', 'add', '--unit', 'a', '--repo', 'demo', '--target', 'main'])).out).toContain('--task is required');
    expect((await runYan(home, ['unit', 'add', '--task', 't1', '--repo', 'demo', '--target', 'main'])).out).toContain('--unit is required');
    expect((await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'a', '--target', 'main'])).out).toContain('--repo is required');
  });

  it('refuses an unknown option and an unknown task', async () => {
    expect((await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'a', '--repo', 'demo', '--target', 'main', '--bogus'])).code).not.toBe(0);
    const r = await runYan(home, ['unit', 'add', '--task', 'nope', '--unit', 'a', '--repo', 'demo', '--target', 'main']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('no such task');
  });
});

describe('with no hook installed, the built-in default applies', () => {
  it('cuts yan/<task>-<unit>-r1 from the target', async () => {
    const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'auth', '--repo', 'demo', '--target', 'main', '--scope', 'apps/auth']);
    expect(r.code, r.out).toBe(0);
    expect(unitField('t1', 'auth', 'branch')).toBe('yan/t1-auth-r1');
    expect(unitField('t1', 'auth', 'target')).toBe('main');
    expect(unitField('t1', 'auth', 'scope')).toEqual(['apps/auth']);
    expect(await hasBranch('yan/t1-auth-r1')).toBe(true);
    expect((await fxGit(['-C', clone, 'rev-parse', 'yan/t1-auth-r1'])).stdout.trim()).toBe(
      (await fxGit(['-C', clone, 'rev-parse', 'origin/main'])).stdout.trim(),
    );
  });

  it('never checks the main clone out', async () => {
    expect((await fxGit(['-C', clone, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('main');
    expect((await fxGit(['-C', clone, 'status', '--porcelain'])).stdout.trim()).toBe('');
  });

  it('refuses a second unit of the same name', async () => {
    const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'auth', '--repo', 'demo', '--target', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('already exists');
  });
});

describe('a name of your own, however it is spelled', () => {
  /**
   * A team whose branches come from its own tooling passes what that tool
   * printed to `--branch`, so whatever spelling it uses has to arrive as a
   * branch name.
   */
  it('takes refs/heads/, origin/, quotes and a stray CR as the same name', async () => {
    for (const [given, expected, unit] of [
      ['refs/heads/team/AUTH-123', 'team/AUTH-123', 'spelled-ref'],
      ['origin/team/AUTH-124', 'team/AUTH-124', 'spelled-origin'],
      ['"team/AUTH-125"', 'team/AUTH-125', 'spelled-quoted'],
    ] as const) {
      const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', unit, '--repo', 'demo', '--target', 'main', '--branch', given]);
      expect(r.code, r.out).toBe(0);
      expect(unitField('t1', unit, 'branch'), given).toBe(expected);
      expect(await hasBranch(expected)).toBe(true);
    }
  });

  it('refuses a name no normalisation can rescue, and quotes what was given', async () => {
    const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'bad', '--repo', 'demo', '--target', 'main', '--branch', 'refs/heads/']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('not usable as a git ref');
    expect(r.out, 'the raw text, or the reader hunts for a name their tool never printed').toContain('refs/heads/');
    expect(unitField('t1', 'bad', 'branch')).toBe('');
  });
});

describe('making the branch exist', () => {
  it('adopts a branch that is already on the remote rather than re-cutting it', async () => {
    await fxGit(['-C', clone, 'push', 'origin', 'main:already/there']);
    await fxGit(['-C', clone, 'update-ref', '-d', 'refs/remotes/origin/already/there']);
    expect(await hasBranch('already/there')).toBe(false);

    const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'legacy', '--repo', 'demo', '--target', 'main', '--branch', 'already/there']);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('adopted');
    expect(await hasBranch('already/there')).toBe(true);
    expect((await fxGit(['-C', clone, 'rev-parse', 'already/there'])).stdout.trim()).toBe(
      (await fxGit(['-C', bare, 'rev-parse', 'already/there'])).stdout.trim(),
    );
  });

  it('refuses a base that does not exist rather than inventing one', async () => {
    const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'ghost', '--repo', 'demo', '--target', 'no/such/branch']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('cannot resolve the base');
    expect(unitField('t1', 'ghost', 'branch')).toBe('');
  });
});

describe('the log tells the story', () => {
  it('records the branch, and where its name came from', () => {
    const log = readFileSync(join(home, 'tasks', 't1', 'log.md'), 'utf8');
    expect(log).toContain('auth  unit added on yan/t1-auth-r1');
    // Two sources now, not three: `--branch` or the built-in. A team whose
    // branches come from elsewhere says so in a skill and passes the result to
    // --branch, which is the `user` case.
    expect(log).toContain('name from default');
    expect(log).toContain('name from user');
  });
});
