import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { Task } from '../../src/records/task/index.js';

/**
 * The commands an agent runs, and the ones `user` reads with, through
 * `bin/yan.mjs` with no terminal — which is how an agent runs them.
 */

afterAll(cleanupTempDirs);

let home = '';

function yan(args: readonly string[], env: Record<string, string | undefined> = {}) {
  return runYan(home, args, env);
}

beforeEach(() => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  Task.create('the first task');
});

describe('the surface', () => {
  it('bare yan without a terminal prints the help, and refuses flags it cannot act on', async () => {
    const bare = await yan([]);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain('Usage: yan');

    expectUsage(await yan(['--cli', 'codex']), 'needs a terminal');
    expectUsage(await yan(['--nope']), "not '--nope'");
  });
});

describe('yan log', () => {
  it('records the three types and reads back what was settled', async () => {
    const env = { YAN_TASK: 't001' };
    expect((await yan(['log', 'agreed', 'only three types'], env)).code).toBe(0);
    expect((await yan(['log', 'paused', 'waiting on review'], env)).code).toBe(0);
    const read = await yan(['log'], env);
    expect(read.stdout).toMatch(/- \d{2}-\d{2} {2}agreed {3}only three types/);
    expect(read.stdout).toContain('paused   waiting on review');

    expectUsage(await yan(['log', 'delivered', 'x'], env), 'one of: agreed changed paused');
    expectUsage(await yan(['log', 'agreed'], env), 'the entry is required');
  });

  it('takes the task from --task, and says so when it has none', async () => {
    expect((await yan(['log', 'changed', 'by flag', '--task', 't001'])).code).toBe(0);
    expect(readFileSync(join(home, 'tasks', 't001', 'log.md'), 'utf8')).toContain('by flag');
    expectUsage(await yan(['log']), '--task <id>');
    expectUsage(await yan(['log', '--task', 't404']), 'no such task: t404');
  });
});

describe('yan deliverable', () => {
  it('adds, edits, marks done and abandons, and context shows the list as it stands', async () => {
    const env = { YAN_TASK: 't001' };
    const added = await yan(['deliverable', 'add', 'the page shows prices', 'the header links to it'], env);
    expect(added.stdout).toMatch(/d1 {2}todo {7}the page shows prices/);
    await yan(['deliverable', 'edit', 'd1', 'the page shows prices per year'], env);
    await yan(['deliverable', 'done', 'd1'], env);
    expectUsage(await yan(['deliverable', 'abandon', 'd2'], env), '--reason is required');
    await yan(['deliverable', 'abandon', 'd2', '--reason', 'no header yet'], env);

    expect(new Task('t001').read().deliverables).toEqual([
      { id: 'd1', text: 'the page shows prices per year', status: 'done', doneAt: expect.any(String) },
      { id: 'd2', text: 'the header links to it', status: 'abandoned', reason: 'no header yet' },
    ]);
    expect((await yan(['context'], env)).stdout).toContain('deliverables  1 done · 1 abandoned');
    expect((await yan(['peek'], env)).stdout, 'peek is user\'s, and leaves them out').not.toContain('the page shows prices');
    expectUsage(await yan(['deliverable', 'done', 'd9'], env), 'this task has d1 d2');
  });
});

describe('yan resource', () => {
  it('keeps one under a name, replaces it, lists and forgets it', async () => {
    const env = { YAN_TASK: 't001' };
    expect((await yan(['resource', 'ls'], env)).stdout.trim()).toBe('no resources');
    expect((await yan(['resource', 'add', 'release', 'https://deploy.example.com/1'], env)).stdout.trim()).toBe('kept release → t001');
    expect((await yan(['resource', 'add', 'release', 'https://deploy.example.com/2'], env)).stdout.trim()).toBe('replaced release → t001');
    expect((await yan(['resource', 'ls'], env)).stdout).toBe('  release  https://deploy.example.com/2\n');
    expect((await yan(['resource', 'rm', 'release'], env)).code).toBe(0);
    expect(new Task('t001').read().resources).toEqual({});
    expectUsage(await yan(['resource', 'rm', 'release'], env), 'this task has none');
  });
});

describe('yan learn', () => {
  it('creates the file with its front matter, prints the path, and lists it', async () => {
    const r = await yan(['learn', 'add', 'pnpm 在这台机器上', '--description', 'only for a pnpm repo']);
    expect(r.code, r.out).toBe(0);
    const path = r.stdout.trim();
    expect(path).toBe(join(home, 'learnings', 'pnpm-在这台机器上.md'));
    expect(readFileSync(path, 'utf8')).toBe('---\nname: pnpm 在这台机器上\ndescription: only for a pnpm repo\n---\n\n');

    expect((await yan(['learn', 'ls'])).stdout).toContain('pnpm 在这台机器上 - only for a pnpm repo');
    expect((await yan(['learn', 'add', 'pnpm 在这台机器上', '--description', 'again'])).out).toContain('already there');
    expectUsage(await yan(['learn', 'add', 'no description']), '--description is required');
  });
});

describe('yan ls and yan peek', () => {
  it('ls lists open tasks with their progress, and the closed ones on request', async () => {
    const t2 = Task.create('a second one');
    t2.addDeliverables(['one', 'two']);
    t2.deliverableDone('d1');
    Task.create('given up').close('abandoned', 'not needed');

    const open = await yan(['ls']);
    expect(open.stdout).toMatch(/^t001 {2}open +- +\S+ {2}the first task$/m);
    expect(open.stdout).toMatch(/^t002 {2}open +1\/2 /m);
    expect(open.stdout).not.toContain('given up');
    expect((await yan(['ls', '--status', 'done'])).stdout).toMatch(/^t003 {2}abandoned/m);

    const json = JSON.parse((await yan(['ls', '--json', '--status', 'all'])).stdout) as { id: string; state: string }[];
    expect(json.map((r) => `${r.id} ${r.state}`)).toEqual(['t001 open', 't002 open', 't003 abandoned']);
  });

  it('context shows the problem whole under its file, the deliverables and the resources', async () => {
    const task = new Task('t001');
    const env = { YAN_TASK: 't001' };
    expect((await yan(['context'], env)).stdout).toMatch(/problem {2}\S+\/t001\/problem\.md\nnothing written yet/);
    writeFileSync(task.problem, 'Why this task exists.\n\nAnd the rest of it.\n');
    task.addDeliverables(['it is done']);
    await yan(['log', 'agreed', 'a decision'], env);

    const r = await yan(['context'], env);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('t001  the first task');
    expect(r.stdout).toContain('Why this task exists.\n\nAnd the rest of it.');
    expect(r.stdout).toMatch(/d1 {2}todo {7}it is done/);
    expect(r.stdout).not.toContain('a decision');
    expect(r.stdout).toContain("no resources yet - 'yan resource add <name> <where>'");

    await yan(['resource', 'add', 'PROJ-412', 'https://jira.example.com/browse/PROJ-412'], env);
    expect((await yan(['context'], env)).stdout).toContain('resources\n  PROJ-412  https://jira.example.com/browse/PROJ-412');
    expectUsage(await yan(['context']), '--task <id>');
  });

  it('peek shows the task on the chain: its trees, the start of its problem, its resources, and no deliverables', async () => {
    const task = new Task('t001');
    const env = { YAN_TASK: 't001' };
    let r = await yan(['peek'], env);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toMatch(/^┌ {2}t001 {2}the first task\n│ {2}open · created \S+ · notes in \S+\/t001$/m);
    expect(r.stdout).toContain('◇  Trees\n│  no repository');
    expect(r.stdout).toContain('◇  Problem  problem.md\n│  nothing written yet');
    expect(r.stdout, 'resources are always there').toContain('◇  Resources\n│  none yet');
    expect(r.stdout.trimEnd().endsWith('└')).toBe(true);

    writeFileSync(task.problem, '# Background\n\nWhy this task\nexists, hard-wrapped.\n\nA second paragraph.\n\nA third.\n');
    task.addDeliverables(['it is done']);
    await yan(['log', 'agreed', 'a decision'], env);
    await yan(['resource', 'add', 'PROJ-412', 'https://jira.example.com/browse/PROJ-412'], env);
    await yan(['resource', 'add', 'design doc', '~/notes/design.md'], env);

    r = await yan(['peek'], env);
    expect(r.stdout, 'the heading and the first paragraph, rewrapped').toContain(
      '│  # Background\n│\n│  Why this task exists, hard-wrapped.\n│  … 2 more paragraphs',
    );
    expect(r.stdout).not.toContain('A second paragraph.');
    expect(r.stdout).not.toContain('it is done');
    expect(r.stdout).not.toContain('a decision');
    expect(r.stdout).toContain('◇  Resources\n│  PROJ-412    https://jira.example.com/browse/PROJ-412\n│  design doc  ~/notes/design.md');

    expectUsage(await yan(['peek']), "yan peek <task-id>");
  });
});
