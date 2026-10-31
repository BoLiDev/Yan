import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, repoRoot, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { Task } from '../../src/records/task/index.js';

/**
 * The commands an agent runs, and the ones `user` reads with, through
 * `bin/yan.mjs` with no terminal — which is how an agent runs them.
 *
 * What a command keeps is checked in the files it writes, and what it says
 * through `--json` where it has one; what it prints for a person to read is
 * checked once a command, by what it says rather than how it is laid out.
 */

afterAll(cleanupTempDirs);

let home = '';

function yan(args: readonly string[], env: Record<string, string | undefined> = {}) {
  return runYan(home, args, env);
}

/** What `yan context --json` says of the task in `env`. */
async function contextOf(env: Record<string, string>): Promise<Record<string, unknown>> {
  return JSON.parse((await yan(['context', '--json'], env)).stdout) as Record<string, unknown>;
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
    const read = (await yan(['log'], env)).stdout;
    expect(read, 'each with its type').toMatch(/agreed\s+only three types/);
    expect(read).toMatch(/paused\s+waiting on review/);

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
    expect((await yan(['deliverable', 'add', 'the page shows prices', 'the header links to it'], env)).code).toBe(0);
    await yan(['deliverable', 'edit', 'd1', 'the page shows prices per year'], env);
    await yan(['deliverable', 'done', 'd1'], env);
    expectUsage(await yan(['deliverable', 'abandon', 'd2'], env), '--reason is required');
    await yan(['deliverable', 'abandon', 'd2', '--reason', 'no header yet'], env);

    const now = [
      { id: 'd1', text: 'the page shows prices per year', status: 'done', doneAt: expect.any(String) },
      { id: 'd2', text: 'the header links to it', status: 'abandoned', reason: 'no header yet' },
    ];
    expect(new Task('t001').read().deliverables).toEqual(now);
    expect((await contextOf(env)).deliverables).toEqual(now);
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

    const removed = (await yan(['deliverable', 'rm', 'd2'], env)).stdout;
    expect(task.read().deliverables.map((d) => `${d.id} ${d.text}`)).toEqual(['d1 one', 'd2 three', 'd3 four']);
    expect(readdirSync(uat).sort(), "the one taken out's file gone, the next one's renamed for its new number").toEqual(['d2-after.png', 'uat.json']);
    expect(readFileSync(join(uat, 'd2-after.png'), 'utf8')).toBe('d3-after.png');
    for (const said of ['by mistake', 'd3 → d2', 'd4 → d3', 'd2-after.png', 'd3-after.png → d2-after.png']) expect(removed, 'it says what it did').toContain(said);

    const moved = (await yan(['deliverable', 'move', 'd3', '1'], env)).stdout;
    expect(task.read().deliverables.map((d) => `${d.id} ${d.text}`)).toEqual(['d1 four', 'd2 one', 'd3 three']);
    expect(JSON.parse(readFileSync(join(uat, 'uat.json'), 'utf8')).files).toEqual({ 'd3-after.png': { for: ['d3'], shows: 'three' } });
    expect(readdirSync(uat).sort()).toEqual(['d3-after.png', 'uat.json']);
    for (const said of ['d3 → d1', 'd1 → d2', 'd2 → d3', 'd2-after.png → d3-after.png']) expect(moved).toContain(said);

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
    const listed = (await yan(['resource', 'ls'], env)).stdout.trim().split('\n').map((line) => line.trim().split(/\s{2,}/));
    expect(listed, 'one a line, a spec ahead of a preview however late it came').toEqual([
      ['spec', 'PROJ-412', 'https://jira.example.com/browse/PROJ-412'],
      ['preview', 'pricing page', 'https://test.example.com/pricing?v=2'],
    ]);
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

    const rows = async (...status: string[]) =>
      (JSON.parse((await yan(['ls', '--json', ...status])).stdout) as { id: string; state: string; done: number; total: number }[]).map((r) => `${r.id} ${r.state} ${r.done}/${r.total}`);
    expect(await rows()).toEqual(['t001 open 0/0', 't002 open 1/2']);
    expect(await rows('--status', 'done')).toEqual(['t003 abandoned 0/0']);
    expect(await rows('--status', 'all')).toEqual(['t001 open 0/0', 't002 open 1/2', 't003 abandoned 0/0']);

    // As user reads it: a line a task, with its title and how far it has come.
    const open = (await yan(['ls'])).stdout;
    expect(open.split('\n').find((l) => l.includes('a second one'))).toContain('1/2');
    expect(open).toContain('the first task');
    expect(open).not.toContain('given up');
  });

  it('context gives the problem whole with its file, the deliverables, the resources and the artifacts, and leaves the log out', async () => {
    const task = new Task('t001');
    const env = { YAN_TASK: 't001' };
    expect(await contextOf(env)).toMatchObject({ id: 't001', title: 'the first task', problem: { file: task.problem, text: '' }, deliverables: [], resources: [], artifacts: [], branches: [] });

    writeFileSync(task.problem, 'Why this task exists.\n\nAnd the rest of it.\n');
    task.addDeliverables(['it is done']);
    await yan(['log', 'agreed', 'a decision'], env);
    await yan(['resource', 'add', 'spec', 'PROJ-412', 'https://jira.example.com/browse/PROJ-412'], env);
    mkdirSync(join(task.dir, 'artifacts', 'uat'), { recursive: true });
    writeFileSync(join(task.dir, 'artifacts', 'uat', 'd1-after.png'), 'png');

    const now = await contextOf(env);
    expect(now.problem).toEqual({ file: task.problem, text: 'Why this task exists.\n\nAnd the rest of it.' });
    expect(now.deliverables).toEqual([{ id: 'd1', text: 'it is done', status: 'todo' }]);
    expect(now.resources).toEqual([{ kind: 'spec', name: 'PROJ-412', where: 'https://jira.example.com/browse/PROJ-412' }]);
    expect(now.artifacts).toEqual([expect.objectContaining({ group: 'uat', path: 'uat/d1-after.png', bytes: 3, url: null })]);

    // As the agent reads it: the problem whole, under the file it is in, and nothing of the log.
    const read = (await yan(['context'], env)).stdout;
    expect(read).toContain(task.problem);
    expect(read).toContain('Why this task exists.\n\nAnd the rest of it.');
    expect(read).not.toContain('a decision');
    expectUsage(await yan(['context']), '--task <id>');
  });

  it('peek shows the task as user glances at it: its trees, the start of its problem, its resources, and no deliverables', async () => {
    const task = new Task('t001');
    const env = { YAN_TASK: 't001' };
    const empty = await yan(['peek'], env);
    expect(empty.code, empty.out).toBe(0);
    for (const said of ['t001', 'the first task', 'no repository', 'nothing written yet']) expect(empty.stdout).toContain(said);

    writeFileSync(task.problem, '# Background\n\nWhy this task\nexists, hard-wrapped.\n\nA second paragraph.\n\nA third.\n');
    task.addDeliverables(['it is done']);
    await yan(['log', 'agreed', 'a decision'], env);
    await yan(['resource', 'add', 'general', 'design doc', '~/notes/design.md'], env);
    await yan(['resource', 'add', 'spec', 'PROJ-412', 'https://jira.example.com/browse/PROJ-412'], env);
    await yan(['resource', 'add', 'spec', 'PRD', 'https://docs.example.com/prd'], env);

    const shown = (await yan(['peek'], env)).stdout;
    expect(shown, 'the heading and the first paragraph, rewrapped').toContain('# Background');
    expect(shown).toContain('Why this task exists, hard-wrapped.');
    expect(shown, 'and how much more there is').toContain('2 more paragraphs');
    for (const left of ['A second paragraph.', 'it is done', 'a decision']) expect(shown).not.toContain(left);
    for (const named of ['PROJ-412', 'https://jira.example.com/browse/PROJ-412', 'PRD', 'https://docs.example.com/prd', 'design doc', '~/notes/design.md']) expect(shown).toContain(named);
    expect(shown.indexOf('PRD'), 'by kind, the specs ahead of what was added before them').toBeLessThan(shown.indexOf('design doc'));

    expectUsage(await yan(['peek']), "yan peek <task-id>");
  });
});

describe('yan debug', () => {
  it('prints what each agent would be told on starting the task', async () => {
    const task = new Task('t001');
    const skills = readdirSync(join(repoRoot, 'plugin', 'skills')).map((s) => `yan:${s}`);
    const folders = ['artifacts/design/', 'artifacts/docs/', 'artifacts/uat/', 'artifacts/misc/'];

    const claude = (await yan(['debug', 't001'])).stdout;
    expect(claude, "claude: where the task's files are").toContain(task.dir);
    for (const folder of folders) expect(claude, 'and which folder takes what').toContain(folder);
    for (const skill of skills) expect(claude, 'and each skill of yan\'s plugin').toContain(skill);

    // codex takes no plugin, so it is told it all, and hears of no skill.
    const codex = (await yan(['debug', 't001', '--cli', 'codex'])).stdout;
    expect(codex).toContain(task.dir);
    for (const folder of folders) expect(codex).toContain(folder);
    for (const command of ['yan context', 'yan log', 'yan resource', 'yan uat add', 'yan uat ready']) expect(codex).toContain(command);
    for (const skill of skills) expect(codex).not.toContain(skill);
    expect(codex, 'no tree here, so nothing on branches').not.toContain('yan branch abandon');
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
    const recorded = (): { files: Record<string, unknown>; notes: Record<string, string> } => JSON.parse(readFileSync(join(uat, 'uat.json'), 'utf8'));

    expect((await yan(['uat', 'add', 'd1-before.png', '--for', 'd1', '--before', '590', 'wide'], env)).stdout.trim()).toBe('recorded d1-before.png for d1 → t001');
    await yan(['uat', 'add', join(uat, 'd1-after.png'), '--for', 'd1', '--after', 'about 1000 wide'], env);
    await yan(['uat', 'add', 'd1-d3.webm', '--for', 'd1,d3', 'dragged in and marked'], env);
    expect((await yan(['uat', 'note', '--for', 'd2', 'restored from the backup'], env)).stdout.trim()).toBe('noted how d2 was checked → t001');
    expect(recorded()).toEqual({
      version: expect.any(Number),
      files: {
        'd1-before.png': { for: ['d1'], shows: '590 wide', side: 'before' },
        'd1-after.png': { for: ['d1'], shows: 'about 1000 wide', side: 'after' },
        'd1-d3.webm': { for: ['d1', 'd3'], shows: 'dragged in and marked' },
      },
      notes: { d2: 'restored from the backup' },
    });

    // As it is read: every deliverable not given up with what checks it, a file for two under each, and a file
    // in uat/ nothing records after them all.
    const listed = (await yan(['uat'], env)).stdout;
    for (const shown of ['d1-before.png', '590 wide', 'd1-after.png', 'about 1000 wide', 'restored from the backup']) expect(listed).toContain(shown);
    expect(listed.split('d1-d3.webm').length - 1).toBe(2);
    expect(listed, 'one given up has nothing to be checked by').not.toMatch(/\bd4\b/);
    expect(listed.indexOf('stray.png')).toBeGreaterThan(listed.lastIndexOf('d1-d3.webm'));

    expect((await yan(['uat', 'add', 'd1-before.png', '--for', 'd1', 'redone'], env)).stdout).toMatch(/^replaced d1-before\.png/);
    expect(recorded().files['d1-before.png']).toEqual({ for: ['d1'], shows: 'redone' });

    expectUsage(await yan(['uat', 'add', 'nope.png', '--for', 'd1', 'x'], env), 'there is no file nope.png');
    expectUsage(await yan(['uat', 'add', join(task.dir, 'problem.md'), '--for', 'd1', 'x'], env), 'is not in');
    expectUsage(await yan(['uat', 'add', 'stray.png', '--for', 'd9', 'x'], env), 'has no deliverable d9');
    expectUsage(await yan(['uat', 'add', 'stray.png', '--for', 'd4', 'x'], env), 'd4 was given up');
    expectUsage(await yan(['uat', 'add', 'stray.png', 'x'], env), "--for <d>");
    expectUsage(await yan(['uat', 'add', 'stray.png', '--for', 'd3', '--before', '--new', 'x'], env), 'not several');
    await yan(['uat', 'add', 'stray.png', '--for', 'd3', '--new', 'the page that was not there'], env);
    expect(recorded().files['stray.png']).toEqual({ for: ['d3'], shows: 'the page that was not there', side: 'new' });
    await yan(['uat', 'rm', 'stray.png'], env);

    expect((await yan(['uat', 'rm', 'd2'], env)).stdout.trim()).toBe('forgot the note on d2 → t001');
    expect((await yan(['uat', 'rm', 'd1-d3.webm'], env)).stdout.trim()).toBe('forgot d1-d3.webm → t001');
    expect((await yan(['context'], env)).stdout, 'context counts the deliverables with something to check them by, d1 alone of the three').toContain('1 of 3');
    expect((await contextOf(env)).uat).toEqual({ files: [{ path: 'd1-before.png', for: ['d1'], shows: 'redone' }, { path: 'd1-after.png', for: ['d1'], shows: 'about 1000 wide', side: 'after' }], notes: {} });
  });
});
