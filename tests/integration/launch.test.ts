import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkBareRemote, mkClone, mkTempDir, mkYanHome } from '../helpers/fixtures.js';
import { CREATE_NEW, enter, OPENING_PROMPT, type EntryPrompts } from '../../src/cli/shared/launch.js';
import { leaseHeldBy, returnTree } from '../../src/externals/worktree/index.js';
import { Task } from '../../src/records/task/index.js';
import { normalizePath } from '../../src/util/paths.js';

/**
 * Bare `yan`, in process: the prompts and the agent are stand-ins, and
 * everything between them — the task, the tree, the argv — is real.
 */

afterAll(cleanupTempDirs);

interface Started {
  readonly cli: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

let home = '';
let started: Started[] = [];

/** Answers given in advance; a question nobody answered fails the test. */
function answers(given: { entry: string; title?: string; tree?: boolean }): EntryPrompts & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    chooseEntry: async () => given.entry,
    askTitle: async () => {
      if (given.title === undefined) throw new Error('asked for a title');
      return given.title;
    },
    confirmTree: async (repo, why = '') => {
      asked.push(`${why} ${repo}`.trim());
      if (given.tree === undefined) throw new Error('asked about a tree');
      return given.tree;
    },
  };
}

function run(prompts: EntryPrompts, cwd: string, options: { cli?: string; extra?: string[] } = {}): Promise<number> {
  return enter({ ...(options.cli === undefined ? {} : { cli: options.cli }), extra: options.extra ?? [] }, {
    prompts,
    cwd,
    start: (cli, argv, opts) => {
      started.push({ cli, argv, cwd: opts.cwd, env: opts.env });
      return 0;
    },
  });
}

beforeEach(() => {
  home = mkYanHome(mkTempDir());
  process.env.YAN_POOL_ROOT = mkTempDir('yan-pool-');
  started = [];
});

afterEach(() => {
  delete process.env.YAN_POOL_ROOT;
});

/** A clone of a fresh bare remote, as `user` keeps one. */
async function aClone(): Promise<{ bare: string; clone: string }> {
  const bare = await mkBareRemote(join(mkTempDir(), 'origin.git'));
  const clone = normalizePath(realpathSync(await mkClone(bare, join(mkTempDir(), 'demo'))));
  return { bare, clone };
}

describe('a new task', () => {
  it('outside a repository has no tree, and the agent starts where yan was typed', async () => {
    const here = normalizePath(realpathSync(mkTempDir()));
    expect(await run(answers({ entry: CREATE_NEW, title: 'write the docs' }), here)).toBe(0);

    expect(Task.list()).toEqual(['t001']);
    expect(new Task('t001').read()).toMatchObject({ title: 'write the docs', state: 'open' });
    expect(new Task('t001').read().repo).toBeUndefined();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ cli: 'claude', cwd: here, argv: ['--append-system-prompt', OPENING_PROMPT] });
    expect(started[0]?.env.YAN_TASK).toBe('t001');
    expect(started[0]?.env.YAN_VAULT).toBe(home);
  });

  it('in a clone, gets a tree on yan/<id> cut from origin, when user says yes', async () => {
    const { bare, clone } = await aClone();
    const prompts = answers({ entry: CREATE_NEW, title: 'fix the parser', tree: true });
    await run(prompts, clone);

    const task = new Task('t001').read();
    expect(task.repo).toBe(bare);
    const lease = leaseHeldBy('t001');
    expect(lease).toBeDefined();
    expect(started[0]?.cwd).toBe(lease?.path);
    expect((await fxGit(['rev-parse', '--abbrev-ref', 'HEAD'], lease?.path)).stdout.trim()).toBe('yan/t001');
    expect(existsSync(join(lease?.path ?? '', 'README.md'))).toBe(true);
  });

  it('in a clone, has no tree when user says no', async () => {
    const { clone } = await aClone();
    await run(answers({ entry: CREATE_NEW, title: 'just notes', tree: false }), clone);
    expect(new Task('t001').read().repo).toBeUndefined();
    expect(leaseHeldBy('t001')).toBeUndefined();
    expect(started[0]?.cwd).toBe(clone);
  });
});

describe('an existing task', () => {
  it('starts in the tree it holds, asking nothing', async () => {
    const { clone } = await aClone();
    await run(answers({ entry: CREATE_NEW, title: 'x', tree: true }), clone);
    const tree = leaseHeldBy('t001')?.path;

    await run(answers({ entry: 't001' }), normalizePath(realpathSync(mkTempDir())));
    expect(started[1]?.cwd).toBe(tree);
  });

  it('with a repository but no tree here, opens one when yan is typed in a clone of it', async () => {
    const { bare, clone } = await aClone();
    await run(answers({ entry: CREATE_NEW, title: 'x', tree: true }), clone);
    const tree = leaseHeldBy('t001')?.path as string;
    // Another machine pushed the branch, and this one has no tree.
    writeFileSync(join(tree, 'work.txt'), 'from the other machine\n');
    await fxGit(['add', '.'], tree);
    await fxGit(['commit', '-m', 'work'], tree);
    await fxGit(['push', '-u', 'origin', 'yan/t001'], tree);
    returnTree('t001');

    const elsewhere = normalizePath(realpathSync(await mkClone(bare, join(mkTempDir(), 'second'))));
    const prompts = answers({ entry: 't001', tree: true });
    await run(prompts, elsewhere);
    expect(prompts.asked[0]).toContain('t001 has no tree on this machine.');
    const again = leaseHeldBy('t001')?.path as string;
    expect(started[1]?.cwd).toBe(again);
    expect(existsSync(join(again, 'work.txt')), 'picked up from origin, not cut afresh').toBe(true);
  });

  it('with a repository and yan typed elsewhere, starts here and says why', async () => {
    const { clone } = await aClone();
    await run(answers({ entry: CREATE_NEW, title: 'x', tree: true }), clone);
    returnTree('t001');
    const here = normalizePath(realpathSync(mkTempDir()));
    await run(answers({ entry: 't001' }), here);
    expect(started[1]?.cwd).toBe(here);
  });
});

describe('the harness', () => {
  it('is config.json\'s, with its model, and --cli swaps it for another without the model', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ cli: 'codex', model: 'gpt-x', effort: 'high' }));
    const here = normalizePath(realpathSync(mkTempDir()));
    await run(answers({ entry: CREATE_NEW, title: 'a' }), here, { extra: ['--search'] });
    expect(started[0]?.cli).toBe('codex');
    expect(started[0]?.argv).toEqual([
      '-m', 'gpt-x', '-c', 'model_reasoning_effort=high',
      '-c', `developer_instructions=${JSON.stringify(OPENING_PROMPT)}`,
      '--search',
    ]);

    await run(answers({ entry: 't001' }), here, { cli: 'claude' });
    expect(started[1]?.argv).toEqual(['--append-system-prompt', OPENING_PROMPT]);
  });

  it('refuses a CLI yan cannot start, before anything is created', async () => {
    const result = await run(answers({ entry: CREATE_NEW, title: 'a' }), mkTempDir(), { cli: 'vim' })
      .then(() => ({ code: 0, message: '' }), (e: { exitCode: number; message: string }) => ({ code: e.exitCode, message: e.message }));
    expect(result.code).toBe(2);
    expect(result.message).toContain('claude codex agy');
    expect(Task.list()).toEqual([]);
  });
});
