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
 * `yan unit add`, ported from `tests/integration/yan-unit-add.test.sh` and
 * `tests/unit/yan-unit-args.test.sh`.
 *
 * Phase 7 Trace: "`unit add` stops when the `branch-name` hook exits non-zero
 * and never falls back to a default."
 *
 * That half is the one worth a real repository. The failure it guards against
 * is silent: yan would create `yan/t1-api-r1`, the team's naming rules would
 * reject it at the forge much later, and by then the branch has commits on it.
 * So the test does not only check the exit code — it checks that NO branch was
 * created and NO unit was written.
 *
 * Real git against a local bare remote. Nothing here touches the network.
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

function writeHook(body: string): void {
  const dir = join(home, 'hooks');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'branch-name');
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

beforeAll(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  bare = await mkBareRemote(join(tmp, 'remote.git'));
  clone = await mkClone(bare, join(home, 'repos', 'demo'));
  // A clone is where the registry says it is now, not where a convention put
  // it (v3 td repos.md §2). The path does not change; only the reason yan
  // can find it.
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

  it('never checks the main clone out (boundaries.md §9.1)', async () => {
    expect((await fxGit(['-C', clone, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()).toBe('main');
    expect((await fxGit(['-C', clone, 'status', '--porcelain'])).stdout.trim()).toBe('');
  });

  it('refuses a second unit of the same name', async () => {
    const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'auth', '--repo', 'demo', '--target', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('already exists');
  });
});

describe('the hook refuses, so nothing happens', () => {
  it('stops, reports the hook\'s own words, and creates no branch', async () => {
    writeHook('printf "AUTH-123 has no branch yet; ask the release manager\\n" >&2; exit 1');

    const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'api', '--repo', 'demo', '--target', 'main']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('refused');
    expect(r.out).toContain('ask the release manager');

    expect(unitField('t1', 'api', 'branch')).toBe('');
    expect(unitCount('t1')).toBe(1);
    // THE regression: yan must not quietly fall back to its built-in default.
    expect(await hasBranch('yan/t1-api-r1')).toBe(false);
  });
});

describe('a hook that answers owns the name', () => {
  it('uses the last line as is, whatever shape it has', async () => {
    writeHook('printf "looked up the ticket...\\n"; printf "team/AUTH-123_integration\\n"');

    const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'api', '--repo', 'demo', '--target', 'main']);
    expect(r.code, r.out).toBe(0);
    expect(unitField('t1', 'api', 'branch')).toBe('team/AUTH-123_integration');
    expect(await hasBranch('team/AUTH-123_integration')).toBe(true);
  });

  it('is not asked at all when --branch was given', async () => {
    writeHook('exit 1');

    const r = await runYan(home, ['unit', 'add', '--task', 't1', '--unit', 'docs', '--repo', 'demo', '--target', 'main', '--branch', 'spike/docs']);
    expect(r.code, r.out).toBe(0);
    expect(unitField('t1', 'docs', 'branch')).toBe('spike/docs');
    expect(await hasBranch('spike/docs')).toBe(true);

    rmSync(join(home, 'hooks', 'branch-name'));
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
    expect(log).toContain('name from hook');
    expect(log).toContain('name from user');
  });
});
