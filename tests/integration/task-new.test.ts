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
import { createTask } from '../../src/cli/task.js';

/**
 * `yan task new`. What it has to keep proving: create ends with `user` inside
 * the task, with its units added and their integration branches really cut.
 *
 * Real git against local bare remotes. The main agent is `process.execPath`,
 * which reads an empty stdin and exits 0, so "it entered" stays an
 * observation. `HERDR_PANE_ID` is cleared: the runner really is in a pane, and
 * the suite must not relabel it.
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

    // The id is a plain sequence number; the readable title is in brief.md.
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

    // …and create ended by starting the main agent in this pane.
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
    // The record is printed before the pane is handed over.
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

describe('the clone is fetched once per clone, not once per unit', () => {
  /**
   * One fetch per clone, however many units share it. `add` is injected, so
   * what is under test is how often the network is reached and which units are
   * told it happened.
   */
  function createWithFakes(units: Array<{ repo: string; target: string; scope?: string[] }>) {
    const freshened: string[] = [];
    const addedWith: Array<{ repo: string; fetched: boolean }> = [];
    const previous = process.env.YAN_HOME;
    process.env.YAN_HOME = home;
    try {
      const result = createTask(
        {
          title: 'fetch dedup',
          units: units.map((u) => ({
            repo: u.repo,
            target: u.target,
            scope: u.scope ?? [],
            needs: [],
          })),
        },
        {
          freshen: (_command, clone) => {
            freshened.push(clone);
          },
          add: (options) => {
            addedWith.push({ repo: options.repo ?? '', fetched: options.fetched === true });
            return {
              task: options.task ?? '',
              unit: options.unit ?? '',
              branch: 'b',
              target: options.target ?? '',
              name_from: 'default',
              branch_state: 'cut from origin/main',
            };
          },
        },
      );
      return { result, freshened, addedWith };
    } finally {
      if (previous === undefined) delete process.env.YAN_HOME;
      else process.env.YAN_HOME = previous;
    }
  }

  it('fetches one clone once, however many units come off it', () => {
    const { result, freshened } = createWithFakes([
      { repo: 'monorepo-x', target: 'main', scope: ['apps/auth'] },
      { repo: 'monorepo-x', target: 'main', scope: ['apps/admin'] },
      { repo: 'monorepo-x', target: 'main', scope: ['apps/api'] },
    ]);
    expect(result.units).toHaveLength(3);
    expect(freshened).toHaveLength(1);
  });

  it('still fetches each distinct clone', () => {
    const { freshened } = createWithFakes([
      { repo: 'monorepo-x', target: 'main', scope: ['apps/auth'] },
      { repo: 'proto', target: 'main' },
      { repo: 'monorepo-x', target: 'main', scope: ['apps/admin'] },
    ]);
    expect(freshened).toHaveLength(2);
    expect(new Set(freshened).size).toBe(2);
  });

  it('keys on the resolved clone, so a name and a path are not fetched twice', () => {
    const { freshened } = createWithFakes([
      { repo: 'monorepo-x', target: 'main', scope: ['apps/auth'] },
      { repo: join(home, 'repos', 'monorepo-x'), target: 'main', scope: ['apps/admin'] },
    ]);
    expect(freshened).toHaveLength(1);
  });

  it('tells the units it fetched that it did, so they do not fetch again', () => {
    const { addedWith } = createWithFakes([
      { repo: 'monorepo-x', target: 'main', scope: ['apps/auth'] },
      { repo: 'monorepo-x', target: 'main', scope: ['apps/admin'] },
    ]);
    expect(addedWith.every((a) => a.fetched)).toBe(true);
  });

  it('does not claim a clone it could not resolve was fetched', () => {
    // An unresolvable repo still reaches `add`, which raises the error naming
    // the unit — but it must not be told its clone was freshened.
    const { freshened, addedWith } = createWithFakes([
      { repo: 'monorepo-x', target: 'main', scope: ['apps/auth'] },
      { repo: 'no-such-repo', target: 'main' },
    ]);
    expect(freshened).toHaveLength(1);
    expect(addedWith.find((a) => a.repo === 'no-such-repo')?.fetched).toBe(false);
    expect(addedWith.find((a) => a.repo === 'monorepo-x')?.fetched).toBe(true);
  });
});
