/// <reference lib="dom" />
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoKey } from '../../src/util/repo-key.js';
import { cleanupTempDirs, fxGit, mkClone, mkEmptyRemote, mkTempDir } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

let served: Served;

beforeAll(async () => {
  // A repository the task keeps a branch in, and an earlier one it gave up.
  const root = mkTempDir('yan-e2e-repo-');
  const url = await mkEmptyRemote(join(root, 'web.git'));
  const clone = await mkClone(url, join(root, 'web'));
  const commit = async (files: Record<string, string>, message: string): Promise<void> => {
    for (const [rel, body] of Object.entries(files)) write(clone, rel, body);
    await fxGit(['add', '-A'], clone);
    await fxGit(['-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'commit', '-q', '-m', message], clone);
  };
  await commit({ 'a.txt': 'a\n' }, 'start');
  await fxGit(['push', '-q', 'origin', 'HEAD:main'], clone);
  await fxGit(['checkout', '-q', '-b', 'feat/retry'], clone);
  await commit({ 'retry.ts': 'export const tries = 3;\n' }, 'retry three times');
  await fxGit(['push', '-q', '-u', 'origin', 'feat/retry'], clone);

  const v = await vault((home) => {
    write(home, 'tasks/t001/task.json', taskJson('t001', 'pay retries', {
      repos: [{ url, branch: 'feat/retry', earlierBranches: ['feat/old-try'], branchMarks: { 'feat/old-try': 'abandoned' } }],
      resources: { 'WEB-1': 'https://tracker.example/WEB-1', 'pr 42': 'https://git.example/web/pull/42', notes: 'ask design about the banner' },
      resourceKinds: { 'WEB-1': 'spec', 'pr 42': 'mr', notes: 'general' },
    }));
    write(home, '.machine/config.json', JSON.stringify({ version: 1, vaults: {}, clones: { [repoKey(url)]: clone } }));
  });
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

describe("a task's nav", () => {
  it('opens MR on a page of its branches, where Enter opens the one picked, named in the column', async () => {
    const { page, errors } = await open(served.url('/#/t/t001'));
    const nav = page.locator('#middle');
    await nav.getByRole('link', { name: 'MR', exact: true }).click();
    expect(page.url()).toMatch(/#\/t\/t001\/mr$/);
    const right = page.locator('#right');
    await right.getByText('feat/old-try').waitFor();
    await right.getByText('abandoned').waitFor();
    expect(await right.getByText('https://git.example/web/pull/42').count(), 'its merge request shown nowhere').toBe(0);

    // The branch the tree is on is picked first.
    await page.keyboard.press('Enter');
    await expect.poll(() => page.url()).toMatch(/#\/t\/t001\/b\/0\/changes$/);
    await nav.getByRole('button', { name: 'feat/retry' }).waitFor();
    await nav.getByText('retry.ts').waitFor();
    expect(errors).toEqual([]);
  });

  it('leaves the merge requests out of Resources too', async () => {
    const { page } = await open(served.url('/#/t/t001'));
    await page.locator('#middle').getByRole('link', { name: 'Resources', exact: true }).click();
    const right = page.locator('#right');
    await right.getByText('https://tracker.example/WEB-1').waitFor();
    await right.getByText('ask design about the banner').waitFor();
    expect(await right.getByText('https://git.example/web/pull/42').count()).toBe(0);
  });
});
