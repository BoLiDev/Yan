import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { openingPrompt, skillsPrompt } from '../../src/cli/shared/launch.js';
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
    expectUsage(await yan(['--repo', 'app']), 'given with --new');
    expectUsage(await yan(['--new', 'x', '--repo', 'app', '--no-repo']), 'give one');
    expectUsage(await yan(['--new', 'x', '--repo', 'app:packages/web']), 'needs a terminal');
    expectUsage(await yan(['--task', 't001', '--new', 'x']), 'give one');
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

  it('takes one out and moves one, saying which numbers changed and what uat/ did to follow', async () => {
    const env = { YAN_TASK: 't001' };
    const task = new Task('t001');
    await yan(['deliverable', 'add', 'one', 'by mistake', 'three', 'four'], env);
    const uat = join(task.dir, 'artifacts', 'uat');
    mkdirSync(uat, { recursive: true });
    for (const f of ['d2-after.png', 'd3-after.png']) writeFileSync(join(uat, f), f);
    await yan(['uat', 'add', 'd2-after.png', '--for', 'd2', 'the mistake'], env);
    await yan(['uat', 'add', 'd3-after.png', '--for', 'd3', 'three'], env);

    const removed = await yan(['deliverable', 'rm', 'd2'], env);
    expect(removed.stdout).toBe([
      'removed     d2 by mistake',
      'renumbered  d3 → d2, d4 → d3',
      'uat         deleted d2-after.png',
      'uat         d3-after.png → d2-after.png',
      '',
    ].join('\n'));
    expect(readFileSync(join(uat, 'd2-after.png'), 'utf8')).toBe('d3-after.png');

    const moved = await yan(['deliverable', 'move', 'd3', '1'], env);
    expect(moved.stdout).toMatch(/d1 {2}todo {7}four\nrenumbered {2}d3 → d1, d1 → d2, d2 → d3\nuat {9}d2-after\.png → d3-after\.png\n$/);
    expect(task.read().deliverables.map((d) => d.text)).toEqual(['four', 'one', 'three']);
    expect(JSON.parse(readFileSync(join(uat, 'uat.json'), 'utf8')).files).toEqual({ 'd3-after.png': { for: ['d3'], shows: 'three' } });

    expectUsage(await yan(['deliverable', 'rm'], env), 'which deliverable?');
    expectUsage(await yan(['deliverable', 'move', 'd1'], env), 'to which place?');
    expectUsage(await yan(['deliverable', 'move', 'd1', '7'], env), 'runs from 1 to 3');
  });
});

describe('yan resource', () => {
  it('keeps one under a name as its kind, replaces it, lists them by kind and forgets one', async () => {
    const env = { YAN_TASK: 't001' };
    expect((await yan(['resource', 'ls'], env)).stdout.trim()).toBe('no resources');
    expect((await yan(['resource', 'add', 'preview', 'pricing page', 'https://test.example.com/pricing?v=1'], env)).stdout.trim()).toBe('kept preview pricing page → t001');
    expect((await yan(['resource', 'add', 'preview', 'pricing page', 'https://test.example.com/pricing?v=2'], env)).stdout.trim()).toBe('replaced preview pricing page → t001');
    await yan(['resource', 'add', 'spec', 'PROJ-412', 'https://jira.example.com/browse/PROJ-412'], env);
    expect((await yan(['resource', 'ls'], env)).stdout).toBe(
      '  spec     PROJ-412      https://jira.example.com/browse/PROJ-412\n  preview  pricing page  https://test.example.com/pricing?v=2\n',
    );
    expect((await yan(['resource', 'rm', 'pricing page'], env)).code).toBe(0);
    expect(new Task('t001').read().resources).toEqual({ 'PROJ-412': 'https://jira.example.com/browse/PROJ-412' });
    expectUsage(await yan(['resource', 'rm', 'pricing page'], env), 'this task has PROJ-412');
    expectUsage(await yan(['resource', 'add', 'release', 'v1', 'https://deploy.example.com/1'], env), "'release' is not a kind of resource - one of: spec mr preview run general");
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
    expect(r.stdout).toContain("no resources yet - 'yan resource add <kind> <name> <where>'");

    await yan(['resource', 'add', 'spec', 'PROJ-412', 'https://jira.example.com/browse/PROJ-412'], env);
    expect((await yan(['context'], env)).stdout).toContain('resources\n  spec  PROJ-412  https://jira.example.com/browse/PROJ-412');
    expect((await yan(['context'], env)).stdout).toMatch(/\nno artifacts yet\n\nuat  0 of 1 deliverables have something to check them by/);

    mkdirSync(join(task.dir, 'artifacts', 'uat'), { recursive: true });
    writeFileSync(join(task.dir, 'artifacts', 'uat', 'd1-after.png'), 'png');
    expect((await yan(['context'], env)).stdout).toContain(`artifacts  ${join(task.dir, 'artifacts')}\n  uat/     d1-after.png`);
    const json = JSON.parse((await yan(['context', '--json'], env)).stdout) as Record<string, unknown>;
    expect(json).toMatchObject({ id: 't001', problem: { file: task.problem }, resources: [{ kind: 'spec', name: 'PROJ-412' }], branches: [] });
    expect(json.artifacts).toEqual([expect.objectContaining({ group: 'uat', path: 'uat/d1-after.png', bytes: 3, url: null })]);
    expectUsage(await yan(['context']), '--task <id>');
    const told = (await yan(['debug', 't001'])).stdout;
    expect(told, 'claude is told where the files go and which skills there are').toBe(`${skillsPrompt(task.dir)}\n`);
    const files = told.split('\n')[1] ?? '';
    expect(files.startsWith(`This task's files are in ${task.dir}: `), 'its second line, without waiting for yan:recap').toBe(true);
    for (const folder of ['artifacts/design/', 'artifacts/docs/', 'artifacts/uat/', 'artifacts/misc/']) expect(files).toContain(folder);
    expect((await yan(['debug', 't001', '--cli', 'codex'])).stdout, 'no tree here, so no line on branches').toBe(`${openingPrompt(task.dir)}\n`);
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
    await yan(['resource', 'add', 'general', 'design doc', '~/notes/design.md'], env);
    await yan(['resource', 'add', 'spec', 'PROJ-412', 'https://jira.example.com/browse/PROJ-412'], env);
    await yan(['resource', 'add', 'spec', 'PRD', 'https://docs.example.com/prd'], env);

    r = await yan(['peek'], env);
    expect(r.stdout, 'the heading and the first paragraph, rewrapped').toContain(
      '│  # Background\n│\n│  Why this task exists, hard-wrapped.\n│  … 2 more paragraphs',
    );
    expect(r.stdout).not.toContain('A second paragraph.');
    expect(r.stdout).not.toContain('it is done');
    expect(r.stdout).not.toContain('a decision');
    expect(r.stdout, 'by kind, each named once, as user calls it').toContain(
      '◇  Resources\n│  需求  PROJ-412    https://jira.example.com/browse/PROJ-412\n│        PRD         https://docs.example.com/prd\n│  其他  design doc  ~/notes/design.md',
    );

    expectUsage(await yan(['peek']), "yan peek <task-id>");
  });
});

describe('yan uat', () => {
  it('records each file with the deliverables it shows, notes the rest, and lists what each deliverable has', async () => {
    const task = new Task('t001');
    const env = { YAN_TASK: 't001' };
    task.addDeliverables(['the page is wider', 'the backup runs', 'marks line up', 'android app']);
    task.abandonDeliverable('d4', 'no phone');
    const uat = join(task.dir, 'artifacts', 'uat');
    mkdirSync(uat, { recursive: true });
    for (const f of ['d1-before.png', 'd1-after.png', 'd1-d3.webm', 'stray.png']) writeFileSync(join(uat, f), 'x');

    expect((await yan(['uat'], env)).stdout).toContain('  d1  todo  nothing to check it by yet');
    expect((await yan(['uat', 'add', 'd1-before.png', '--for', 'd1', '--before', '590', 'wide'], env)).stdout.trim()).toBe('recorded d1-before.png for d1 → t001');
    await yan(['uat', 'add', join(uat, 'd1-after.png'), '--for', 'd1', '--after', 'about 1000 wide'], env);
    await yan(['uat', 'add', 'd1-d3.webm', '--for', 'd1,d3', 'dragged in and marked'], env);
    expect((await yan(['uat', 'note', '--for', 'd2', 'restored from the backup'], env)).stdout.trim()).toBe('noted how d2 was checked → t001');

    const listed = (await yan(['uat'], env)).stdout;
    expect(listed).toBe([
      '  d1  todo',
      '      before  d1-before.png  590 wide',
      '      after   d1-after.png   about 1000 wide',
      '      file    d1-d3.webm     dragged in and marked',
      '  d2  todo',
      '      note    restored from the backup',
      '  d3  todo',
      '      file    d1-d3.webm  dragged in and marked',
      '',
      "not recorded - 'yan uat add <file> --for <d> \"<what it shows>\"'",
      '  stray.png',
      '',
    ].join('\n'));
    expect((await yan(['uat', 'add', 'd1-before.png', '--for', 'd1', 'redone'], env)).stdout).toMatch(/^replaced d1-before\.png/);
    expect(JSON.parse(readFileSync(join(uat, 'uat.json'), 'utf8')).files['d1-before.png']).toEqual({ for: ['d1'], shows: 'redone' });

    expectUsage(await yan(['uat', 'add', 'nope.png', '--for', 'd1', 'x'], env), 'there is no file nope.png');
    expectUsage(await yan(['uat', 'add', join(task.dir, 'problem.md'), '--for', 'd1', 'x'], env), 'is not in');
    expectUsage(await yan(['uat', 'add', 'stray.png', '--for', 'd9', 'x'], env), 'has no deliverable d9');
    expectUsage(await yan(['uat', 'add', 'stray.png', '--for', 'd4', 'x'], env), 'd4 was given up');
    expectUsage(await yan(['uat', 'add', 'stray.png', 'x'], env), "--for <d>");
    expectUsage(await yan(['uat', 'add', 'stray.png', '--for', 'd3', '--before', '--new', 'x'], env), 'not several');
    await yan(['uat', 'add', 'stray.png', '--for', 'd3', '--new', 'the page that was not there'], env);
    expect(JSON.parse(readFileSync(join(uat, 'uat.json'), 'utf8')).files['stray.png']).toEqual({ for: ['d3'], shows: 'the page that was not there', side: 'new' });
    expect((await yan(['uat'], env)).stdout).toContain('      new     stray.png');
    await yan(['uat', 'rm', 'stray.png'], env);

    expect((await yan(['uat', 'rm', 'd2'], env)).stdout.trim()).toBe('forgot the note on d2 → t001');
    expect((await yan(['uat', 'rm', 'd1-d3.webm'], env)).stdout.trim()).toBe('forgot d1-d3.webm → t001');
    expect((await yan(['context'], env)).stdout).toContain("uat  1 of 3 deliverables have something to check them by - 'yan uat' lists it");
    const json = JSON.parse((await yan(['context', '--json'], env)).stdout) as { uat: unknown };
    expect(json.uat).toEqual({ files: [{ path: 'd1-before.png', for: ['d1'], shows: 'redone' }, { path: 'd1-after.png', for: ['d1'], shows: 'about 1000 wide', side: 'after' }], notes: {} });
  });
});
