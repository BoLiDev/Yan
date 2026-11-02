/// <reference lib="dom" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeHerdr, type FakeHerdr } from '../helpers/fake-herdr.js';
import { cleanupTempDirs, mkBareRemote, mkClone, mkTempDir } from '../helpers/fixtures.js';
import { WorktreePool } from '../../src/externals/worktree/index.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * A branch's worktree, opened from its card on MR's page in a tab of the
 * task's terminal: one tab for every branch of a repository, another for
 * another repository's. herdr is the stand-in (tests/helpers/fake-herdr.ts),
 * which draws a shell started in a directory as a prompt there.
 */

let served: Served;
let h: FakeHerdr;
let trees: string[] = [];

beforeAll(async () => {
  h = await startFakeHerdr({ version: '0.9.5' });
  const [web, api] = [await mkBareRemote(join(mkTempDir(), 'web.git')), await mkBareRemote(join(mkTempDir(), 'api.git'))];
  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', 'pay retries', {
      repos: [
        { url: web, branch: 'feat/retry', earlierBranches: ['feat/retry-banner'], branchMarks: { 'feat/retry': 'open', 'feat/retry-banner': 'open' } },
        { url: api, branch: 'feat/api-retry' },
      ],
    }));
  });
  // A worktree of each repository on this machine, in the pool serve reads.
  process.env.YAN_POOL_ROOT = join(v.home, '.machine', 'trees');
  trees = [new WorktreePool(await mkClone(web, join(mkTempDir(), 'web'))).get('origin/main', 't001').path, new WorktreePool(await mkClone(api, join(mkTempDir(), 'api'))).get('origin/main', 't001').path];
  delete process.env.YAN_POOL_ROOT;
  mkdirSync(join(v.home, '.machine'), { recursive: true });
  writeFileSync(join(v.home, '.machine', 'config.json'), JSON.stringify({ version: 1, vaults: {}, clones: {}, terminals: [h.terminal(v.home, 't001')] }));
  served = await serve(v.home, { HERDR_BIN_PATH: h.bin });
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  await h?.close();
  cleanupTempDirs();
});

describe("a branch's worktree", () => {
  it('opens from its card in a tab of its repository, which every branch of it shares, and another repository in a tab of its own', async () => {
    const { page, errors } = await open(served.url('/#/t/t001/mr'));
    const right = page.locator('#right');
    const openFrom = async (branch: string, repo: string): Promise<void> => {
      await page.goto(served.url('/#/t/t001/mr'));
      await right.getByText(branch, { exact: true }).hover();
      await right.getByRole('button', { name: `Open the worktree of ${repo}` }).click();
      await page.getByRole('tab', { name: new RegExp(repo) }).and(page.locator('[aria-selected="true"]')).waitFor();
    };
    const tabs = async (): Promise<string[]> => page.getByRole('tablist', { name: 'Terminal' }).getByRole('tab').allTextContents();

    await openFrom('feat/retry', 'web');
    expect(await tabs()).toEqual(['Agent', 'web']);
    // The shell is in the worktree of web, as the stand-in draws its prompt.
    await right.getByText(trees[0] as string).waitFor();

    await openFrom('feat/retry-banner', 'web');
    expect(await tabs(), 'another branch of web: the same tab').toEqual(['Agent', 'web']);

    await openFrom('feat/api-retry', 'api');
    expect(await tabs(), 'another repository: a tab of its own').toEqual(['Agent', 'web', 'api']);
    await right.getByText(trees[1] as string).waitFor();
    expect(h.tabs().map((t) => t.label)).toEqual(['agent', 'pay retries · web', 'pay retries · api']);
    expect(errors).toEqual([]);
  });
});
