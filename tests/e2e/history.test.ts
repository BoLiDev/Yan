/// <reference lib="dom" />
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/fixtures.js';
import { closeBrowser, open, push, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * A Markdown artifact's history: the versions an agent pushed and the one
 * `user` wrote on the page, the newest first, each shown against the one
 * before it.
 */

let served: Served;

const V1 = '# 支付重试方案\n\n付款失败后，系统会无限次重试，直到成功为止。\n\n每次重试之间等待 250。\n';
const V2 = '# 支付重试方案\n\n付款失败后，系统最多重试五次，之后提示用户换卡。\n\n每次重试之间等待 250。\n\n## 风险\n\n重试期间用户可能已经换了一张卡。\n';

beforeAll(async () => {
  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', '支付重试'));
    write(dir, 'tasks/t001/artifacts/docs/design.md', V1);
  });
  // An agent on another machine rewrites it and pushes.
  write(v.elsewhere, 'tasks/t001/artifacts/docs/design.md', V2);
  await push(v.elsewhere, 't001: turn ended');
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

describe("a Markdown artifact's history", () => {
  it('lists its versions, newest first, an edit on the page among them, and shows what each changed of the one before', async () => {
    const { page, errors } = await open(served.url('/#/t/t001/a/docs/design.md'));
    const right = page.locator('#right');
    await right.getByText('最多重试五次').waitFor({ timeout: 20_000 });

    // user edits it on the page: a third version.
    await right.getByRole('button', { name: 'Source' }).click();
    const area = right.getByRole('textbox', { name: /docs\/design\.md/ });
    await area.fill(V2.replace('等待 250。', '等待 250 毫秒，之后每次翻倍。'));
    await page.keyboard.press('Control+s');
    await right.getByText('Type to edit').waitFor();

    await right.getByRole('button', { name: 'History' }).click();
    const versions = right.getByRole('complementary', { name: 'Versions' }).getByRole('list').getByRole('button');
    await expect.poll(() => versions.count(), { timeout: 20_000 }).toBe(3);
    expect(await versions.nth(0).innerText()).toMatch(/current[\s\S]*Edited on the page/);
    expect(await versions.nth(1).innerText()).toContain('t001: turn ended');
    expect(await versions.nth(2).innerText()).toContain('seed');

    // The newest is shown to start with: what the edit changed, and inside the line, only the words.
    await right.locator('ins', { hasText: '毫秒，之后每次翻倍' }).waitFor();
    expect(await right.getByText('支付重试方案').count(), 'what the edit left alone, away from it, is not shown').toBe(0);
    if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, 'h1-changes.png') });

    await versions.nth(1).click();
    await right.locator('del', { hasText: '会无限次' }).waitFor();
    await right.getByText('重试期间用户可能已经换了一张卡。').waitFor();
    if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, 'h2-agent.png') });

    // As the document it was, what is new since the version before tinted.
    await right.getByRole('button', { name: 'Document' }).click();
    await right.getByRole('heading', { name: '风险' }).waitFor();
    expect(await right.locator('[data-fresh]').count()).toBeGreaterThan(0);
    expect(await right.getByText('毫秒').count(), 'the version picked, not the newest').toBe(0);
    if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, 'h3-document.png') });

    await versions.nth(2).click();
    await right.getByRole('button', { name: 'Changes' }).click();
    await right.getByText('会无限次重试').waitFor();
    expect(errors).toEqual([]);
  }, 60_000);
});
