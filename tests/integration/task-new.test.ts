import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkTempDir,
  mkYanHome,
  repoRoot,
  runYan,
} from '../helpers/fixtures.js';

/**
 * `yan task new`, ported from `tests/integration/yan-task-new.test.sh` and
 * `tests/unit/yan-task-new-args.test.sh`.
 *
 * Phase 8 ports the last two commands that had no TypeScript twin. What the
 * bash test proved and this one has to keep proving:
 *
 *   CREATE ENDS WITH `user` INSIDE THE TASK. Create is not "mkdir plus an empty
 *   brief" — it is the contract, the involved repositories, a concrete scope, at
 *   least one unit, and the main agent running. A create that stopped at
 *   task.json would leave the whole product sentence unfinished, and the enter
 *   step is `yan continue` itself rather than a second copy of it.
 *
 * Real git against local bare remotes, because `yan unit add` really cuts the
 * integration branches. The terminal is the stand-in that records calls.
 */

afterAll(cleanupTempDirs);

let home = '';
let calls = '';

function detail(id: string): {
  title: string;
  units: Array<Record<string, unknown>>;
} {
  const r = runYan(home, ['ls', id, '--json']);
  expect(r.code, r.out).toBe(0);
  return JSON.parse(r.stdout) as { title: string; units: Array<Record<string, unknown>> };
}

function callLog(): string {
  try {
    return readFileSync(join(calls, 'calls'), 'utf8');
  } catch {
    return '';
  }
}

function hasBranch(repo: string, branch: string): boolean {
  return (
    fxGit(['-C', join(home, 'repos', repo), 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0
  );
}

beforeAll(() => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true });
  calls = join(tmp, 'calls');
  // The enter step really runs, so the terminal it reaches is the recording
  // stand-in rather than a multiplexer.
  cpSync(join(repoRoot, 'tests', 'stub', 'lib-term.sh'), join(home, 'bin', 'lib-term.sh'));

  mkBareRemote(join(tmp, 'mono.git'));
  mkBareRemote(join(tmp, 'proto.git'));
  expect(runYan(home, ['repo-add', join(tmp, 'mono.git'), '--name', 'monorepo-x']).code).toBe(0);
  expect(runYan(home, ['repo-add', join(tmp, 'proto.git'), '--name', 'proto']).code).toBe(0);
  mkdirSync(join(home, 'repos', 'monorepo-x', 'apps', 'auth'), { recursive: true });
  mkdirSync(join(home, 'repos', 'monorepo-x', 'apps', 'admin'), { recursive: true });
});

describe('three units across two repositories, in one order-sensitive run', () => {
  it('creates the task, its brief, its units and its branches', () => {
    const r = runYan(
      home,
      [
        'task', 'new',
        '--title', 'unify the auth header',
        '--description', 'the same header, everywhere',
        '--repo', 'monorepo-x', '--scope', 'apps/auth', '--target', 'main',
        '--repo', 'monorepo-x', '--scope', 'apps/admin', '--target', 'main',
        '--repo', 'proto', '--target', 'main', '--needs', 'auth',
      ],
      { YAN_STUB_TERM_DIR: calls },
    );
    expect(r.code, r.out).toBe(0);

    // The id is t042-shaped: a plain sequence number, because it also goes into
    // branch names and the readable title lives in brief.md.
    expect(existsSync(join(home, 'tasks', 't001', 'task.json'))).toBe(true);
    const d = detail('t001');
    expect(d.title).toBe('unify the auth header');
    expect(readFileSync(join(home, 'tasks', 't001', 'brief.md'), 'utf8')).toContain(
      'the same header, everywhere',
    );
    expect(readFileSync(join(home, 'tasks', 't001', 'log.md'), 'utf8')).toContain('task created');

    // One unit per package, named after the package, and the flags after each
    // --repo bound to that --repo.
    expect(d.units.map((u) => u.name)).toEqual(['auth', 'admin', 'proto']);
    expect(d.units[0]?.scope).toEqual(['apps/auth']);
    expect(d.units[1]?.scope).toEqual(['apps/admin']);
    // A non-monorepo unit scopes the repo root, which is the empty prefix list.
    expect(d.units[2]?.scope).toEqual([]);
    expect(d.units[2]?.needs).toEqual(['auth']);
    expect(d.units[0]?.target).toBe('main');

    // The integration branches really exist in the main clones.
    expect(hasBranch('monorepo-x', 'yan/t001-auth-r1')).toBe(true);
    expect(hasBranch('monorepo-x', 'yan/t001-admin-r1')).toBe(true);
    expect(hasBranch('proto', 'yan/t001-proto-r1')).toBe(true);
  });

  it('ends with the main agent running, through `yan continue` and not a copy of it', () => {
    const log = callLog();
    expect(log).toContain('container_create name=t001 unify the auth header');
    const start = log.split('\n').find((l) => l.startsWith('agent_start ')) ?? '';
    expect(start).toContain('label=yan');
    expect(start).toContain('YAN_TASK=t001');
  });
});

describe('the id', () => {
  it('counts on from the highest number on disk, and takes an explicit one as given', () => {
    expect(
      runYan(home, ['task', 'new', '--title', 'something else', '--repo', 'proto', '--target', 'main'],
        { YAN_STUB_TERM_DIR: calls }).code,
    ).toBe(0);
    expect(existsSync(join(home, 'tasks', 't002', 'task.json'))).toBe(true);

    expect(
      runYan(home, ['task', 'new', '--id', 't042', '--title', 'the readable title lives here', '--repo', 'proto', '--target', 'main'],
        { YAN_STUB_TERM_DIR: calls }).code,
    ).toBe(0);
    expect(existsSync(join(home, 'tasks', 't042', 'task.json'))).toBe(true);

    expect(
      runYan(home, ['task', 'new', '--title', 'after t042', '--repo', 'proto', '--target', 'main'],
        { YAN_STUB_TERM_DIR: calls }).code,
    ).toBe(0);
    expect(existsSync(join(home, 'tasks', 't043', 'task.json'))).toBe(true);
  });

  it('refuses an id that is already taken, before anything is written', () => {
    const r = runYan(home, ['task', 'new', '--id', 't042', '--title', 'again', '--repo', 'proto', '--target', 'main']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('already exists');
  });
});

describe('--json still enters; it only changes how the result is printed', () => {
  it('reports the task, its units, and the enter record', () => {
    const r = runYan(home, ['task', 'new', '--title', 'as json', '--repo', 'proto', '--target', 'main', '--json'],
      { YAN_STUB_TERM_DIR: calls });
    expect(r.code, r.out).toBe(0);
    const seen = JSON.parse(r.stdout) as {
      task: string;
      units: string[];
      entered: { started: boolean } | null;
    };
    expect(seen.task).toBe('t044');
    expect(seen.units).toEqual(['proto']);
    expect(seen.entered?.started).toBe(true);
  });
});

describe('what it refuses, and never guesses', () => {
  it('names every unit that has no --target, by repo', () => {
    const r = runYan(home, ['task', 'new', '--title', 'no target', '--repo', 'proto']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('--target is required for --repo proto');
    expect(r.out).toContain('never guesses');
  });

  it('refuses a unit flag with no --repo before it', () => {
    const r = runYan(home, ['task', 'new', '--title', 'orphan', '--scope', 'apps/auth', '--repo', 'proto', '--target', 'main']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('has to come after a --repo');
  });

  it('refuses with no title and no repo, and names the flags, because there is no TTY here', () => {
    const r = runYan(home, ['task', 'new']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('--title');
    expect(r.out).toContain('--repo');
  });

  it('creates nothing when it refuses', () => {
    expect(existsSync(join(home, 'tasks', 't045'))).toBe(false);
  });
});
