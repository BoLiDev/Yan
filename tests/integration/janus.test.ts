import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkBareRemote, mkClone, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { enter, type EntryChain, type EntryPrompts } from '../../src/cli/shared/launch.js';
import { register } from '../../src/records/repos/index.js';
import { JANUS, Task } from '../../src/records/task/index.js';
import { normalizePath } from '../../src/util/paths.js';

/**
 * Janus, the agent kept beside the tasks: started by bare `yan --janus` in
 * process, the agent a stand-in, and its commands through `bin/yan`.
 */

afterAll(cleanupTempDirs);

let home = '';
let started: { cli: string; argv: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];

const chain: EntryChain = { begin: () => undefined, working: () => ({ update: () => undefined, finish: () => undefined }), say: () => undefined, end: () => undefined };
/** Janus is asked nothing as it starts: any question fails the test. */
const never = async (): Promise<never> => {
  throw new Error('asked something');
};
const prompts: EntryPrompts = { chooseEntry: never, askTitle: never, chooseRepos: never, confirmTree: never, chooseScope: never };

const janus = (cwd: string, cli?: string): Promise<number> => enter({ extra: [], janus: true, ...(cli === undefined ? {} : { cli }) }, {
  prompts, chain, cwd,
  start: (c, argv, opts) => {
    started.push({ cli: c, argv, cwd: opts.cwd, env: opts.env });
    return 0;
  },
});
const flag = (i: number, name: string): string[] => (started[i]?.argv ?? []).flatMap((w, at, all) => (w === name ? [all[at + 1] ?? ''] : []));
const yan = (args: readonly string[], task: string | undefined = JANUS) => runYan(home, args, { YAN_TASK: task });

async function aClone(name: string): Promise<{ bare: string; clone: string }> {
  const bare = await mkBareRemote(join(mkTempDir(), `${name}.git`));
  return { bare, clone: normalizePath(realpathSync(await mkClone(bare, join(mkTempDir(), name)))) };
}

beforeEach(() => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  started = [];
});

describe('Janus', () => {
  it('is there from the first time it is started, where yan was typed, told of every repository\'s clone and how a matter is handed over, and is no task on the list', async () => {
    const demo = await aClone('demo');
    register('demo', demo.bare, demo.clone);
    const here = normalizePath(realpathSync(mkTempDir()));
    expect(await janus(here)).toBe(0);

    expect(new Task(JANUS).read()).toMatchObject({ id: 'janus', title: 'Janus', state: 'open', repos: [] });
    expect(Task.list()).toEqual([]);
    expect(started[0]).toMatchObject({ cli: 'claude', cwd: here });
    expect(started[0]?.env.YAN_TASK).toBe('janus');
    const prompt = flag(0, '--append-system-prompt')[0] ?? '';
    expect(prompt).toContain(`- demo: ${demo.clone}`);
    expect(prompt).toContain('yan tree get');
    expect(prompt).toContain('yan:handoff');
    expect(prompt).toContain(new Task(JANUS).dir);
    expect(prompt, 'nothing of a task\'s: no problem to keep, no recap to start with').not.toContain('problem.md');
    expect(prompt).toContain('Start every session fresh');
    expect(existsSync(join(new Task(JANUS).dir, 'problem.md'))).toBe(false);
    expect(flag(0, '--add-dir')).toEqual([]);

    const made = new Task(JANUS).read().createdAt;
    expect(await janus(here)).toBe(0);
    expect(new Task(JANUS).read().createdAt, 'the same one the second time').toBe(made);
    expect((await yan(['ls', '--status', 'all', '--json'])).stdout).not.toContain('janus');
  });

  it('is told how a matter is handed over in so many words when its CLI takes no skills', async () => {
    expect(await janus(normalizePath(realpathSync(mkTempDir())), 'codex')).toBe(0);
    const prompt = (started[0]?.argv ?? []).join('\n');
    expect(prompt).not.toContain('yan:handoff says how');
    expect(prompt).toContain('--problem <the file>');
  });

  it('is never paused or closed', async () => {
    await janus(normalizePath(realpathSync(mkTempDir())));
    expect((await yan(['pause', '--force'])).code).toBe(2);
    expect((await yan(['done', '--force'])).code).toBe(2);
    expect(new Task(JANUS).read()).toMatchObject({ state: 'open' });
    expect(new Task(JANUS).read().pausedAt).toBeUndefined();
  });

  it('takes a worktree of a repository when it needs one, is started with those it holds, and gives it back; a task cannot', async () => {
    const demo = await aClone('demo');
    register('demo', demo.bare, demo.clone);
    const here = normalizePath(realpathSync(mkTempDir()));
    await janus(here);

    const got = await yan(['tree', 'get', 'demo']);
    expect(got.code, got.stderr).toBe(0);
    const tree = got.stdout.trim();
    expect(existsSync(join(tree, '.git'))).toBe(true);
    expect((await yan(['tree', 'get', 'demo'])).stdout.trim(), 'the one it holds, asked again').toBe(tree);
    expect(JSON.parse((await yan(['tree', 'ls', '--json'])).stdout)).toEqual([{ repo: 'demo', path: tree, branch: null }]);

    writeFileSync(join(tree, 'scratch.txt'), 'x');
    expect((await yan(['tree', 'return', 'demo'])).code, 'not while it holds what is nowhere else').not.toBe(0);
    expect((await yan(['tree', 'return', 'demo', '--force'])).code).toBe(0);
    expect(JSON.parse((await yan(['tree', 'ls', '--json'])).stdout)).toEqual([]);

    expect((await yan(['tree', 'get', 'nope'])).code).toBe(2);
    Task.create('a piece of work');
    expect((await yan(['tree', 'get', 'demo'], 't001')).code).toBe(2);
  });

  it('hands a matter over as a task: numbered, in the repositories named, the handoff its problem.md and the files it carries in its artifacts', async () => {
    const demo = await aClone('demo');
    register('demo', demo.bare, demo.clone);
    await janus(normalizePath(realpathSync(mkTempDir())));
    const mine = join(new Task(JANUS).dir, 'artifacts', 'handoffs');
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, 'retries.md'), '# Retries\n\nPayments retry forever.\n');
    writeFileSync(join(mine, 'sample.json'), '{}');

    const made = await yan(['handoff', 'stop payments retrying forever', '--problem', join(mine, 'retries.md'), '--repo', 'demo', '--artifact', join(mine, 'sample.json'), '--no-start', '--json']);
    expect(made.code, made.stderr).toBe(0);
    expect(JSON.parse(made.stdout)).toMatchObject({ id: 't001', title: 'stop payments retrying forever', started: false });
    const task = new Task('t001');
    expect(task.read()).toMatchObject({ state: 'open', repos: [{ url: demo.bare }] });
    expect(readFileSync(task.problem, 'utf8')).toBe('# Retries\n\nPayments retry forever.\n');
    expect(existsSync(join(task.dir, 'artifacts', 'sample.json'))).toBe(true);
    expect(Task.list()).toEqual(['t001']);

    expect((await yan(['handoff', 'no handoff written', '--no-start'])).code).toBe(2);
    expect((await yan(['handoff', 'x', '--problem', join(mine, 'retries.md'), '--repo', 'nope', '--no-start'])).code).toBe(2);
    expect(Task.list(), 'nothing made by a handoff refused').toEqual(['t001']);
  });
});
