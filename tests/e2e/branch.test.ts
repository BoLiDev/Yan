/// <reference lib="dom" />
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoKey } from '../../src/util/repo-key.js';
import { cleanupTempDirs, fxGit, mkClone, mkEmptyRemote, mkTempDir } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

let served: Served;
let clone = '';

/** A commit in `dir` of `files`, by a fixed author, so the page has something to say of each. */
async function commit(dir: string, files: Record<string, string>, message: string): Promise<void> {
  for (const [rel, body] of Object.entries(files)) write(dir, rel, body);
  await fxGit(['add', '-A'], dir);
  await fxGit(['-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'commit', '-q', '-m', message], dir);
}

beforeAll(async () => {
  // A repository the task works in: its feature branch took main in once on the way, as a branch kept up to date does.
  const root = mkTempDir('yan-e2e-repo-');
  const url = await mkEmptyRemote(join(root, 'web.git'));
  clone = await mkClone(url, join(root, 'web'));
  await commit(clone, { 'a.txt': 'a\n' }, 'start');
  await fxGit(['push', '-q', 'origin', 'HEAD:main'], clone);
  await fxGit(['checkout', '-q', '-b', 'feat/retry'], clone);
  await commit(clone, { 'retry.ts': 'export const tries = 3;\n' }, 'retry three times');
  await fxGit(['checkout', '-q', 'main'], clone);
  await commit(clone, { 'from-main.txt': 'came from main\n' }, 'something on main');
  await fxGit(['push', '-q', 'origin', 'main'], clone);
  await fxGit(['checkout', '-q', 'feat/retry'], clone);
  await fxGit(['-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'merge', '-q', '--no-ff', '-m', 'take main in', 'main'], clone);
  await fxGit(['push', '-q', '-u', 'origin', 'feat/retry'], clone);

  const v = await vault((home) => {
    write(home, 'tasks/t001/task.json', taskJson('t001', 'pay retries', { repos: [{ url, branch: 'feat/retry' }] }));
    write(home, '.machine/config.json', JSON.stringify({ version: 1, vaults: {}, clones: { [repoKey(url)]: clone } }));
  });
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

describe("a task's branch", () => {
  it('lists what the branch changes against main, and not what it took from main', async () => {
    const { page, errors } = await open(served.url('/#/t/t001/b/0/changes'));
    const middle = page.getByRole('complementary', { name: 'Task' });
    await middle.getByText('retry.ts').waitFor({ timeout: 20_000 });
    expect(await middle.getByText('from-main.txt').count()).toBe(0);
    await page.getByRole('main').getByText('export const tries = 3;').waitFor();
    expect(errors).toEqual([]);
  });

  it('shows a merge commit on the branch as what it brought onto it', async () => {
    const { page } = await open(served.url('/#/t/t001/b/0/commits'));
    await page.getByRole('link', { name: /take main in/ }).click();
    const right = page.getByRole('main');
    await right.getByRole('link', { name: 'from-main.txt' }).waitFor({ timeout: 20_000 });
    await right.getByText('came from main').waitFor();
  });

  it('says it was merged once main has it, after the branch is gone from origin', async () => {
    await fxGit(['checkout', '-q', 'main'], clone);
    await fxGit(['-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'merge', '-q', '--no-ff', '-m', 'Merge pull request #7 from feat/retry', 'feat/retry'], clone);
    await fxGit(['push', '-q', 'origin', 'main'], clone);
    await fxGit(['push', '-q', 'origin', '--delete', 'feat/retry'], clone);

    const { page } = await open(served.url('/#/t/t001/b/0/changes'));
    await page.getByRole('button', { name: 'Pull now' }).click();
    await page.getByRole('complementary', { name: 'Task' }).getByText(/PR #7/).waitFor({ timeout: 20_000 });
  });
});
