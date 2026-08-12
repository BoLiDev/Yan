import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cleanupTempDirs,
  fxGit,
  mkBareRemote,
  mkTempDir,
  mkYanHome,
  registerRepo,
  runYan,
} from '../helpers/fixtures.js';

/**
 * `yan task new`, ported from `tests/integration/yan-task-new.test.sh` and
 * `tests/unit/yan-task-new-args.test.sh`.
 *
 * Phase 8 ports the last two commands that had no TypeScript twin. What the
 * bash test proved and this one has to keep proving:
 *
 *   Create ends with `user` inside the task. Create is not "mkdir plus an empty
 *   brief" — it is the contract, the involved repositories, a concrete scope, at
 *   least one unit, and the main agent running. A create that stopped at
 *   task.json would leave the whole product sentence unfinished, and the enter
 *   step is `yan continue` itself rather than a second copy of it.
 *
 * Real git against local bare remotes, because `yan unit add` really cuts the
 * integration branches. The main agent is `process.execPath`, which reads an
 * empty stdin and exits 0 — a real spawn, so "it entered" stays an observation.
 * `HERDR_PANE_ID` is cleared for the same reason as in `continue.test.ts`: the
 * runner really is inside a Herdr pane and the suite must not relabel it.
 */

afterAll(cleanupTempDirs);

let home = '';

const config = `${JSON.stringify(
  {
    version: 1,
    agents: { yan: process.execPath, shift: process.execPath },
    remote_git: { kind: 'github' },
  },
  null,
  2,
)}\n`;

async function yan(args: readonly string[]) {
  return await runYan(home, args, { HERDR_PANE_ID: '' });
}

async function detail(id: string): Promise<{ title: string; units: Array<Record<string, unknown>> }> {
  const r = await yan(['ls', id, '--json']);
  expect(r.code, r.out).toBe(0);
  return JSON.parse(r.stdout) as { title: string; units: Array<Record<string, unknown>> };
}

async function hasBranch(repo: string, branch: string): Promise<boolean> {
  return (
    (await fxGit(['-C', join(home, 'repos', repo), 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
  );
}

beforeAll(async () => {
  const tmp = mkTempDir();
  home = mkYanHome(join(tmp, 'home'), { withDist: true, config });

  await mkBareRemote(join(tmp, 'mono.git'));
  await mkBareRemote(join(tmp, 'proto.git'));
  expect((await yan(['repo', 'add', join(tmp, 'mono.git'), '--name', 'monorepo-x', '--path', join(home, 'repos')])).code).toBe(0);
  expect((await yan(['repo', 'add', join(tmp, 'proto.git'), '--name', 'proto', '--path', join(home, 'repos')])).code).toBe(0);
  mkdirSync(join(home, 'repos', 'monorepo-x', 'apps', 'auth'), { recursive: true });
  mkdirSync(join(home, 'repos', 'monorepo-x', 'apps', 'admin'), { recursive: true });
  // A clone is where the registry says it is now, not where a convention put
  // it (v3 td repos.md §2). The path does not change; only the reason yan
  // can find it.
  for (const name of ['monorepo-x', 'proto']) registerRepo(home, name, join(home, 'repos', name));
});

describe('three units across two repositories, in one order-sensitive run', () => {
  it('creates the task, its brief, its units and its branches, and enters it', async () => {
    const r = await yan([
      'task', 'new',
      '--title', 'unify the auth header',
      '--description', 'the same header, everywhere',
      '--repo', 'monorepo-x', '--scope', 'apps/auth', '--target', 'main',
      '--repo', 'monorepo-x', '--scope', 'apps/admin', '--target', 'main',
      '--repo', 'proto', '--target', 'main', '--needs', 'auth',
    ]);
    expect(r.code, r.out).toBe(0);

    // The id is t042-shaped: a plain sequence number, because it also goes into
    // branch names and the readable title lives in brief.md.
    expect(existsSync(join(home, 'tasks', 't001', 'task.json'))).toBe(true);
    const d = await detail('t001');
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
    expect(await hasBranch('monorepo-x', 'yan/t001-auth-r1')).toBe(true);
    expect(await hasBranch('monorepo-x', 'yan/t001-admin-r1')).toBe(true);
    expect(await hasBranch('proto', 'yan/t001-proto-r1')).toBe(true);

    // …and create ended by starting the main agent in this pane, which is
    // `yan continue` itself and not a second copy of it.
    expect(r.stdout).toContain('starting in this pane');
    // The enter step's per-task lock is held for exactly as long as the agent.
    expect(existsSync(join(home, 'tasks', 't001', '.enter.lock'))).toBe(false);
  });
});

describe('the id', () => {
  it('counts on from the highest number on disk, and takes an explicit one as given', async () => {
    expect((await yan(['task', 'new', '--title', 'something else', '--repo', 'proto', '--target', 'main'])).code).toBe(0);
    expect(existsSync(join(home, 'tasks', 't002', 'task.json'))).toBe(true);

    expect((await yan(['task', 'new', '--id', 't042', '--title', 'the readable title lives here', '--repo', 'proto', '--target', 'main'])).code).toBe(0);
    expect(existsSync(join(home, 'tasks', 't042', 'task.json'))).toBe(true);

    expect((await yan(['task', 'new', '--title', 'after t042', '--repo', 'proto', '--target', 'main'])).code).toBe(0);
    expect(existsSync(join(home, 'tasks', 't043', 'task.json'))).toBe(true);
  });

  it('refuses an id that is already taken, before anything is written', async () => {
    const r = await yan(['task', 'new', '--id', 't042', '--title', 'again', '--repo', 'proto', '--target', 'main']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('already exists');
  });
});

describe('--json still enters; it only changes how the result is printed', () => {
  it('reports the task, its units, and the enter record', async () => {
    const r = await yan(['task', 'new', '--title', 'as json', '--repo', 'proto', '--target', 'main', '--json']);
    expect(r.code, r.out).toBe(0);
    const seen = JSON.parse(r.stdout) as {
      task: string;
      units: string[];
      entered: { started: boolean; task: string };
    };
    expect(seen.task).toBe('t044');
    expect(seen.units).toEqual(['proto']);
    // The record is printed before the pane is handed over, which is the whole
    // reason entering is two phases: a record that only arrived once the agent
    // had finished would arrive hours late or never.
    expect(seen.entered.started).toBe(true);
    expect(seen.entered.task).toBe('t044');
  });
});

describe('what it refuses, and never guesses', () => {
  it('names every unit that has no --target, by repo', async () => {
    const r = await yan(['task', 'new', '--title', 'no target', '--repo', 'proto']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('--target is required for --repo proto');
    expect(r.out).toContain('never guesses');
  });

  it('refuses a unit flag with no --repo before it', async () => {
    const r = await yan(['task', 'new', '--title', 'orphan', '--scope', 'apps/auth', '--repo', 'proto', '--target', 'main']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('has to come after a --repo');
  });

  it('refuses with no title and no repo, and names the flags, because there is no TTY here', async () => {
    const r = await yan(['task', 'new']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('--title');
    expect(r.out).toContain('--repo');
  });

  it('creates nothing when it refuses', () => {
    expect(existsSync(join(home, 'tasks', 't045'))).toBe(false);
  });
});
