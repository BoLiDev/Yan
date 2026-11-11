/// <reference lib="dom" />
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { repoKey } from '../../src/util/repo-key.js';
import { cleanupTempDirs, fxGit, mkClone, mkEmptyRemote, mkTempDir, runYan } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * A review made on the page: a comment on a passage of a Markdown artifact
 * and one on a line of a branch's diff, gathered as they are read, then
 * written to the vault as one file, pushed, which `yan review` prints.
 */

let served: Served;
let home = '';
let origin = '';

/** A picture of the page for whoever is changing it, kept where $YAN_SHOTS says; none otherwise. */
async function shot(page: Page, name: string): Promise<void> {
  if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, `${name}.png`) });
}

beforeAll(async () => {
  const root = mkTempDir('yan-e2e-review-');
  const url = await mkEmptyRemote(join(root, 'web.git'));
  const clone = await mkClone(url, join(root, 'web'));
  const commit = async (files: Record<string, string>, message: string): Promise<void> => {
    for (const [rel, body] of Object.entries(files)) write(clone, rel, body);
    await fxGit(['add', '-A'], clone);
    await fxGit(['-c', 'user.name=agent', '-c', 'user.email=agent@example.com', 'commit', '-q', '-m', message], clone);
  };
  await commit({ 'retry.ts': 'export const tries = 1;\n' }, 'start');
  await fxGit(['push', '-q', 'origin', 'HEAD:main'], clone);
  await fxGit(['checkout', '-q', '-b', 'feat/retry'], clone);
  await commit({ 'retry.ts': 'export const tries = 1;\nexport const backoff = 250;\n' }, 'back off between tries');
  await fxGit(['push', '-q', '-u', 'origin', 'feat/retry'], clone);

  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', 'pay retries', { repos: [{ url, branch: 'feat/retry' }] }));
    write(dir, 'tasks/t001/artifacts/docs/design.md', '# Design\n\nA payment is retried forever.\n\nEach try waits a little longer.\n');
    write(dir, '.machine/config.json', JSON.stringify({ version: 1, vaults: {}, clones: { [repoKey(url)]: clone } }));
  });
  home = v.home;
  origin = v.origin;
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

/** Select a word by a double click on it, right click it, and comment on it from the menu. */
async function comment(page: Page, word: string, text: string): Promise<void> {
  const at = page.getByRole('main').getByText(word, { exact: false }).first();
  const box = await at.evaluate((el, w) => {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
      const i = (n as Text).data.indexOf(w);
      if (i < 0) continue;
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    throw new Error(`${w} is not there`);
  }, word);
  await page.mouse.dblclick(box.x, box.y);
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Comment' }).click();
  await page.getByRole('textbox', { name: 'Comment' }).fill(text);
  await page.keyboard.press('Enter');
}

describe('a review', () => {
  it('gathers comments on a document and on a diff, and is written to the vault whole, pushed, for an agent to read', async () => {
    const { page, errors } = await open(served.url('/#/t/t001/a/docs/design.md'));
    await page.getByRole('main').getByText('A payment is retried forever.').waitFor();
    await comment(page, 'forever', 'Five times at most.');
    await page.getByRole('button', { name: /Review · 1 comment/ }).waitFor();
    await shot(page, '1-markdown-commented');

    await page.goto(served.url('/#/t/t001/b/0/changes'));
    await page.getByRole('main').getByText('backoff').first().waitFor({ timeout: 20_000 });
    await comment(page, 'backoff', 'In what unit?');
    await page.getByRole('button', { name: /Review · 2 comments/ }).click();
    await page.getByRole('textbox', { name: 'Overall' }).fill('Close. Two questions.');
    await shot(page, '2-review-box');
    await page.getByRole('button', { name: 'Finish' }).click();
    await page.getByText(/tasks\/t001\/reviews\/.+\.md/).waitFor({ timeout: 20_000 });
    await shot(page, '3-written');

    const printed = (await runYan(home, ['review', '--task', 't001'])).stdout;
    expect(printed).toContain('Close. Two questions.');
    expect(printed).toContain('## 1. artifacts/docs/design.md, line 3\n\n> forever\n\nFive times at most.');
    expect(printed).toMatch(/## 2\. web, branch feat\/retry, retry\.ts, line 2\n\n```\nbackoff\n```\n\nIn what unit\?/);
    const name = /reviews\/(\S+\.md)/.exec(printed)?.[1] ?? '';
    expect((await fxGit(['show', `main:tasks/t001/reviews/${name}`], origin)).stdout, 'pushed').toContain('Five times at most.');
    expect(errors).toEqual([]);
  }, 60_000);
});
