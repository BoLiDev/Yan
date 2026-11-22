import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs, mkTempDir, mkYanHome, runYan } from '../helpers/fixtures.js';
import { expectUsage } from '../helpers/usage.js';
import { readZip } from '../helpers/zip.js';
import { Task } from '../../src/records/task/index.js';

/**
 * `yan pack`: one task as a zip `user` carries to an agent with no yan and
 * no vault. What matters is what is in the zip, what is kept out of it, and
 * that the vault is as it was.
 */

afterAll(cleanupTempDirs);

let home = '';
let out = '';
let task: Task;

function yan(args: readonly string[]) {
  return runYan(home, args, { YAN_TASK: task.id });
}

function put(rel: string, body: string): void {
  mkdirSync(join(home, rel, '..'), { recursive: true });
  writeFileSync(join(home, rel), body);
}

/** The pack `args` makes, as what it says it packed and what the zip holds. */
async function packed(args: readonly string[] = []): Promise<{ said: { task: string; file: string; files: string[] }; zip: Map<string, Buffer> }> {
  const r = await yan(['pack', '--out', out, '--json', ...args]);
  expect(r.code, r.out).toBe(0);
  const said = JSON.parse(r.stdout) as { task: string; file: string; files: string[] };
  return { said, zip: readZip(said.file) };
}

beforeEach(() => {
  home = mkYanHome(mkTempDir(), { withDist: true });
  out = join(mkTempDir(), 'handed', 'over.zip');
  task = Task.create('retry the payment', [{ url: 'git@example.com:org/web.git' }]);
  task.addDeliverables(['a failed payment is retried once', 'the retry shows in the order']);
  task.abandonDeliverable('d2', 'the order page is another team\'s');
  task.keepBranch('git@example.com:org/web.git', 'fix/pay-retry');
  task.addResource('spec', 'ticket', 'https://tickets.example.com/42');
  put(`tasks/${task.id}/problem.md`, '# Payments\n\nA failed payment is never tried again.\n');
  put(`tasks/${task.id}/log.md`, '- 11-20  agreed   retry once, after a minute\n');
  put(`tasks/${task.id}/artifacts/docs/设计.md`, 'the design\n');
  put('learnings/tests.md', 'run the tests before pushing\n');
  put('drafts/20261120-1000-idea.md', 'an idea about other work\n');
  put('tasks/t999/problem.md', 'another task\'s problem\n');
});

describe('yan pack', () => {
  it('writes one folder holding the task as it is, the learnings, and a README that says the task to an agent with no yan', async () => {
    const { said, zip } = await packed();
    expect(said.task).toBe(task.id);
    const root = `yan-${task.id}`;
    expect([...zip.keys()].sort()).toEqual([
      `${root}/README.md`,
      `${root}/learnings/tests.md`,
      `${root}/task/artifacts/docs/设计.md`,
      `${root}/task/log.md`,
      `${root}/task/problem.md`,
      `${root}/task/task.json`,
    ]);
    expect(said.files.slice().sort()).toEqual([...zip.keys()].sort());
    expect(zip.get(`${root}/task/problem.md`)?.toString()).toContain('never tried again');
    expect(JSON.parse(zip.get(`${root}/task/task.json`)?.toString() ?? '{}')).toMatchObject({ id: task.id, title: 'retry the payment' });

    const readme = zip.get(`${root}/README.md`)?.toString() ?? '';
    for (const told of ['retry the payment', 'a failed payment is retried once', 'the order page is another team\'s', 'git@example.com:org/web.git', 'fix/pay-retry', 'https://tickets.example.com/42', 'task/problem.md', 'task/log.md']) {
      expect(readme, told).toContain(told);
    }
  });

  it('keeps out what is not the task\'s: another task, the drafts unless asked for, a link out of the vault, a dot file, and the artifacts when told', async () => {
    const secret = join(mkTempDir(), 'secret.txt');
    writeFileSync(secret, 'not the vault\'s');
    symlinkSync(secret, join(task.dir, 'artifacts', 'linked.txt'));
    put(`tasks/${task.id}/artifacts/.DS_Store`, 'x');

    const plain = [...(await packed()).zip.keys()];
    expect(plain.filter((name) => /t999|drafts|linked|DS_Store/.test(name))).toEqual([]);

    const withDrafts = [...(await packed(['--drafts'])).zip.keys()];
    expect(withDrafts).toContain(`yan-${task.id}/drafts/20261120-1000-idea.md`);

    const light = (await packed(['--no-artifacts'])).zip;
    expect([...light.keys()].filter((name) => name.includes('artifacts/'))).toEqual([]);
    expect(light.get(`yan-${task.id}/README.md`)?.toString()).not.toContain('task/artifacts/');
  });

  it('carries the brief agreed with user for the other agent to read first, and only the artifacts named', async () => {
    const brief = join(mkTempDir(), 'brief.md');
    writeFileSync(brief, '# What to do\n\nOnly the retry itself; leave the order page.\n');
    put(`tasks/${task.id}/artifacts/misc/query.sql`, 'select 1\n');

    const { zip } = await packed(['--brief', brief, '--artifact', 'docs']);
    const root = `yan-${task.id}`;
    expect(zip.get(`${root}/BRIEF.md`)?.toString()).toContain('leave the order page');
    expect(zip.get(`${root}/README.md`)?.toString()).toContain('BRIEF.md');
    expect([...zip.keys()].filter((name) => name.includes('artifacts/'))).toEqual([`${root}/task/artifacts/docs/设计.md`]);

    expectUsage(await yan(['pack', '--out', out, '--artifact', 'nope']), 'no artifact nope');
    expectUsage(await yan(['pack', '--out', out, '--brief', join(mkTempDir(), 'not-written.md')]), 'write the brief first');
  });

  it('as one document, says the brief, the task, its problem and its log in a single file, with nothing beside it', async () => {
    const brief = join(mkTempDir(), 'brief.md');
    writeFileSync(brief, 'Only the retry itself.\n');
    const file = join(mkTempDir(), 'handover.md');
    const r = await yan(['pack', '--doc', '--brief', brief, '--out', file, '--json']);
    expect(r.code, r.out).toBe(0);
    expect((JSON.parse(r.stdout) as { file: string }).file).toBe(file);
    const text = readFileSync(file, 'utf8');
    for (const told of ['retry the payment', 'Only the retry itself.', 'a failed payment is retried once', 'never tried again', 'retry once, after a minute', 'fix/pay-retry']) expect(text, told).toContain(told);
    expect(text, 'no file to point at').not.toContain('task/problem.md');
  });

  it('never writes the zip into the vault, and changes nothing there', async () => {
    const before = JSON.stringify(task.read());
    expectUsage(await yan(['pack', '--out', join(home, 'tasks', task.id, 'artifacts', 'pack.zip')]), 'inside the vault');
    expectUsage(await runYan(home, ['pack', 't404', '--out', out], {}), 'no such task');
    await packed();
    expect(JSON.stringify(task.read())).toBe(before);
  });
});
