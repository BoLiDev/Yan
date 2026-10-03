import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, fxGit, mkBareRemote, mkClone, mkTempDir, mkYanHome } from '../helpers/fixtures.js';
import { CREATE_NEW, enter, OPENING_PROMPT, openingPrompt, type EntryChain, type EntryPrompts, type Said } from '../../src/cli/shared/launch.js';
import { leasesHeldBy, returnTrees } from '../../src/externals/worktree/index.js';
import { register, registry } from '../../src/records/repos/index.js';
import { Task } from '../../src/records/task/index.js';
import { normalizePath } from '../../src/util/paths.js';
import { tildePath } from '../../src/cli/shared/style.js';

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
/** What bare yan said on the chain, one string per line: `kind line`, then its detail. */
let said: string[] = [];

const chain: EntryChain = {
  working: (doing) => {
    said.push(`working ${doing}`);
    return { update: (next) => said.push(`working ${next}`), finish: (s) => note(s) };
  },
  say: (s) => note(s),
  end: (line) => said.push(`end ${line}`),
};

function note(s: Said): void {
  said.push(`${s.kind} ${s.line}`, ...(s.detail ?? []).map((d) => `  ${d}`));
}

/** Answers given in advance; a question nobody answered fails the test. */
function answers(given: { entry: string; title?: string; repos?: string[]; tree?: boolean; scope?: string[] }): EntryPrompts & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    chooseEntry: async () => given.entry,
    askTitle: async () => {
      if (given.title === undefined) throw new Error('asked for a title');
      return given.title;
    },
    chooseRepos: async (repos) => {
      asked.push(`repos: ${repos.map((r) => `${r.name}${r.here ? '*' : ''}`).join(' ')}`);
      if (given.repos === undefined) throw new Error('asked which repositories');
      return given.repos;
    },
    confirmTree: async (repo, why = '') => {
      asked.push(`${why} ${repo}`.trim());
      if (given.tree === undefined) throw new Error('asked about a tree');
      return given.tree;
    },
    chooseScope: async (repo, packages) => {
      asked.push(`scope of ${repo}: ${packages.join(' ')}`);
      if (given.scope === undefined) throw new Error('asked about a scope');
      return given.scope;
    },
  };
}

function run(prompts: EntryPrompts, cwd: string, options: { cli?: string; extra?: string[] } = {}): Promise<number> {
  return enter({ ...(options.cli === undefined ? {} : { cli: options.cli }), extra: options.extra ?? [] }, {
    prompts,
    chain,
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
  said = [];
});

afterEach(() => {
  delete process.env.YAN_POOL_ROOT;
});

/** A clone of a fresh bare remote, as `user` keeps one; `name` is the remote's, so the repository's. */
async function aClone(name = 'demo'): Promise<{ bare: string; clone: string }> {
  const bare = await mkBareRemote(join(mkTempDir(), `${name}.git`));
  const clone = normalizePath(realpathSync(await mkClone(bare, join(mkTempDir(), name))));
  return { bare, clone };
}

/** The one tree t001 holds. */
function treeOf(id = 't001'): string | undefined {
  const held = leasesHeldBy(id);
  return held.length === 1 ? held[0]?.path : undefined;
}

describe('a new task', () => {
  it('outside a repository has no tree, and the agent starts where yan was typed', async () => {
    const here = normalizePath(realpathSync(mkTempDir()));
    expect(await run(answers({ entry: CREATE_NEW, title: 'write the docs' }), here)).toBe(0);

    expect(Task.list()).toEqual(['t001']);
    expect(new Task('t001').read()).toMatchObject({ title: 'write the docs', state: 'open' });
    expect(new Task('t001').read().repos).toEqual([]);
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ cli: 'claude', cwd: here, argv: ['--dangerously-skip-permissions', '--append-system-prompt', OPENING_PROMPT] });
    expect(started[0]?.env.YAN_TASK).toBe('t001');
    expect(started[0]?.env.YAN_VAULT).toBe(home);
  });

  it('in an unregistered clone, offers it picked, registers it, and cuts a tree on yan/<id> from origin', async () => {
    const { bare, clone } = await aClone();
    const prompts = answers({ entry: CREATE_NEW, title: 'fix the parser', repos: ['demo'] });
    await run(prompts, clone);

    expect(prompts.asked[0]).toBe('repos: demo*');
    expect(registry()).toEqual([{ name: 'demo', url: bare, clone }]);
    expect(new Task('t001').read().repos).toEqual([{ url: bare }]);
    const tree = treeOf();
    expect(started[0]?.cwd).toBe(tree);
    expect((await fxGit(['rev-parse', '--abbrev-ref', 'HEAD'], tree)).stdout.trim()).toBe('yan/t001');
    expect(existsSync(join(tree ?? '', 'README.md'))).toBe(true);
    expect(said, 'one step on the chain, saying where the branch came from, then the end').toEqual([
      'working demo: opening a worktree on yan/t001 · fetching origin',
      'working demo: opening a worktree on yan/t001',
      'done demo: worktree on yan/t001, cut from origin/main',
      `  ${tildePath(tree ?? '')}`,
      'end t001  fix the parser · claude starting',
    ]);
  });

  it('cuts from what the clone has when origin cannot be reached, and says so', async () => {
    const { bare, clone } = await aClone();
    // Out of reach, as a remote behind a dropped network is.
    renameSync(bare, `${bare}.away`);
    await run(answers({ entry: CREATE_NEW, title: 'offline', repos: ['demo'] }), clone);

    expect(treeOf()).toBeDefined();
    const warning = said.find((l) => l.startsWith('warn '));
    expect(warning).toBe('warn demo: worktree on yan/t001, cut from origin/main · could not fetch origin, so it may be behind');
    expect(said.at(-1)).toBe('end t001  offline · claude starting');
  });

  it('anywhere, picks several registered repositories: starts in the first tree, adds the others, and says which is which', async () => {
    const web = await aClone('web');
    const api = await aClone('api');
    register('web', web.bare, web.clone);
    register('api', api.bare, api.clone);
    const here = normalizePath(realpathSync(mkTempDir()));
    const prompts = answers({ entry: CREATE_NEW, title: 'one feature, two repos', repos: ['web', 'api'] });
    await run(prompts, here);

    expect(prompts.asked[0]).toBe('repos: api web');
    const task = new Task('t001').read();
    expect(task.repos.map((r) => r.url)).toEqual([api.bare, web.bare]);
    const trees = leasesHeldBy('t001').map((l) => l.path);
    expect(trees).toHaveLength(2);
    const [apiTree, webTree] = [trees.find((t) => t.endsWith('/api')), trees.find((t) => t.endsWith('/web'))];
    expect(started[0]?.cwd).toBe(apiTree);
    expect(started[0]?.argv).toEqual(['--dangerously-skip-permissions', '--add-dir', webTree, '--append-system-prompt', started[0]?.argv.at(-1)]);
    expect(started[0]?.argv.at(-1)).toContain(`This task works in 2 repositories, one worktree each:\n- api: ${apiTree}\n- web: ${webTree}`);

    await run(answers({ entry: 't001' }), here);
    expect(started[1]?.cwd, 'the same trees, the same order').toBe(apiTree);
    expect(started[1]?.argv).toEqual(started[0]?.argv);
  });

  it('with nothing registered and outside a clone, has no tree and asks nothing', async () => {
    const here = normalizePath(realpathSync(mkTempDir()));
    await run(answers({ entry: CREATE_NEW, title: 'x' }), here);
    expect(new Task('t001').read().repos).toEqual([]);
    expect(started[0]?.cwd).toBe(here);
    expect(said[0]).toMatch(/^info no repository is registered and cloned here/);
  });

  it('in a monorepo, asks once which packages it is about, keeps them, and tells the agent every start', async () => {
    const { clone } = await aClone();
    for (const p of ['packages/core', 'packages/web', 'apps/site']) mkdirSync(join(clone, p), { recursive: true });
    const prompts = answers({ entry: CREATE_NEW, title: 'fix the parser', repos: ['demo'], scope: ['packages/core', 'apps/site'] });
    await run(prompts, clone);

    expect(prompts.asked.at(-1)).toContain('apps/site packages/core packages/web');
    expect(new Task('t001').read().repos[0]?.scope).toEqual(['packages/core', 'apps/site']);
    const prompt = openingPrompt([{ name: 'demo', path: treeOf() as string, scope: ['packages/core', 'apps/site'] }]);
    expect(prompt).toContain('`packages/core`, `apps/site`');
    expect(started[0]?.argv.at(-1)).toBe(prompt);

    await run(answers({ entry: 't001' }), clone);
    expect(started[1]?.argv.at(-1), 'not asked again, still told').toBe(prompt);
  });

  it('in a monorepo, keeps no scope when user picks the whole repository', async () => {
    const { clone } = await aClone();
    mkdirSync(join(clone, 'packages', 'core'), { recursive: true });
    await run(answers({ entry: CREATE_NEW, title: 'x', repos: ['demo'], scope: [] }), clone);
    expect(new Task('t001').read().repos).toEqual([{ url: (await fxGit(['remote', 'get-url', 'origin'], clone)).stdout.trim() }]);
    expect(started[0]?.argv.at(-1)).toBe(OPENING_PROMPT);
  });

  it('in a clone, has no tree when user picks no repository, and registers nothing', async () => {
    const { clone } = await aClone();
    await run(answers({ entry: CREATE_NEW, title: 'just notes', repos: [] }), clone);
    expect(new Task('t001').read().repos).toEqual([]);
    expect(leasesHeldBy('t001')).toEqual([]);
    expect(registry()).toEqual([]);
    expect(started[0]?.cwd).toBe(clone);
  });
});

describe('an existing task', () => {
  it('starts in the tree it holds, asking nothing', async () => {
    const { clone } = await aClone();
    await run(answers({ entry: CREATE_NEW, title: 'x', repos: ['demo'] }), clone);
    const tree = treeOf();

    said = [];
    await run(answers({ entry: 't001' }), normalizePath(realpathSync(mkTempDir())));
    expect(started[1]?.cwd).toBe(tree);
    expect(said).toEqual(['done demo: worktree on yan/t001, already here', `  ${tildePath(tree ?? '')}`, 'end t001  x · claude starting']);
  });

  it('with a repository but no tree here, opens one from its linked clone, wherever yan is typed', async () => {
    const { bare, clone } = await aClone();
    await run(answers({ entry: CREATE_NEW, title: 'x', repos: ['demo'] }), clone);
    const tree = treeOf() as string;
    // Another machine pushed the branch, and this one has no tree.
    writeFileSync(join(tree, 'work.txt'), 'from the other machine\n');
    await fxGit(['add', '.'], tree);
    await fxGit(['commit', '-m', 'work'], tree);
    await fxGit(['push', '-u', 'origin', 'yan/t001'], tree);
    returnTrees('t001');

    // This machine keeps its clone somewhere else now.
    const second = normalizePath(realpathSync(await mkClone(bare, join(mkTempDir(), 'second'))));
    register('demo', bare, second);
    const prompts = answers({ entry: 't001', tree: true });
    await run(prompts, normalizePath(realpathSync(mkTempDir())));
    expect(prompts.asked[0]).toContain('t001 has no tree of demo on this machine.');
    const again = treeOf() as string;
    expect(again.startsWith(clone), 'cut from the linked clone').toBe(false);
    expect(started[1]?.cwd).toBe(again);
    expect(existsSync(join(again, 'work.txt')), 'picked up from origin, not cut afresh').toBe(true);
    expect(said).toContain('done demo: worktree on yan/t001, picked up from origin/yan/t001');
  });

  it('with a repository not cloned on this machine, starts here and says why', async () => {
    const { bare } = await aClone();
    Task.create('x', [{ url: bare }]);
    const here = normalizePath(realpathSync(mkTempDir()));
    await run(answers({ entry: 't001' }), here);
    expect(started[0]?.cwd).toBe(here);
    expect(said[0]).toMatch(/^warn demo has no clone on this machine, so no tree/);
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
      '--dangerously-bypass-approvals-and-sandbox',
      '-c', `developer_instructions=${JSON.stringify(OPENING_PROMPT)}`,
      '--search',
    ]);

    await run(answers({ entry: 't001' }), here, { cli: 'claude' });
    expect(started[1]?.argv).toEqual(['--dangerously-skip-permissions', '--append-system-prompt', OPENING_PROMPT]);
  });

  it('keeps its approvals when config.json says skipPermissions: false, whichever CLI runs', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ cli: 'claude', skipPermissions: false }));
    const here = normalizePath(realpathSync(mkTempDir()));
    await run(answers({ entry: CREATE_NEW, title: 'a' }), here);
    expect(started[0]?.argv).toEqual(['--append-system-prompt', OPENING_PROMPT]);

    await run(answers({ entry: 't001' }), here, { cli: 'codex' });
    expect(started[1]?.argv).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('refuses a CLI yan cannot start, before anything is created', async () => {
    const result = await run(answers({ entry: CREATE_NEW, title: 'a' }), mkTempDir(), { cli: 'vim' })
      .then(() => ({ code: 0, message: '' }), (e: { exitCode: number; message: string }) => ({ code: e.exitCode, message: e.message }));
    expect(result.code).toBe(2);
    expect(result.message).toContain('claude codex agy');
    expect(Task.list()).toEqual([]);
  });
});
