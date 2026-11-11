/// <reference lib="dom" />
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/fixtures.js';
import { closeBrowser, open, push, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * A Markdown artifact's history: the versions an agent pushed and the one
 * `user` wrote on the page, the newest first in History's menu, each drawn
 * as the document with what it changed of the one before marked in it.
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
  it('lists its last changes in a menu, an edit on the page among them, and draws the one picked as the document with what it changed marked', async () => {
    const { page, errors } = await open(served.url('/#/t/t001/a/docs/design.md'));
    const right = page.locator('#right');
    await right.getByText('最多重试五次').waitFor({ timeout: 20_000 });

    // user edits it on the page: a third version.
    await right.getByRole('button', { name: 'Source' }).click();
    const area = right.getByRole('textbox', { name: /docs\/design\.md/ });
    await area.fill(V2.replace('等待 250。', '等待 250 毫秒，之后每次翻倍。'));
    await page.keyboard.press('Control+s');
    await right.getByText('Type to edit').waitFor();

    // The file is shown as itself until a change is picked from History's menu.
    await right.getByRole('button', { name: 'Rendered' }).click();
    await right.getByRole('heading', { name: '风险' }).waitFor();
    expect(await right.locator('ins, del, [data-diff]').count()).toBe(0);
    await right.getByRole('button', { name: 'History' }).click();
    const versions = page.getByRole('menuitem');
    await expect.poll(() => versions.count(), { timeout: 20_000 }).toBe(3);
    expect(await versions.nth(0).innerText()).toMatch(/latest[\s\S]*Edited on the page/);
    expect(await versions.nth(1).innerText()).toContain('t001: turn ended');
    expect(await versions.nth(2).innerText()).toContain('seed');
    if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, 'h1-menu.png') });

    // The agent's change, drawn as the document: a paragraph reworded, with its words marked, and a part added.
    await versions.nth(1).click();
    await right.locator('del', { hasText: '会无限次' }).waitFor();
    await right.locator('ins', { hasText: '最多' }).waitFor();
    expect(await right.locator('[data-diff=add]').getByRole('heading', { name: '风险' }).count()).toBe(1);
    expect(await right.getByText('毫秒').count(), 'as that version had it, not as it is now').toBe(0);
    if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, 'h2-agent.png') });

    // What the change took out is commented on where it is drawn, the comment saying which change, and that it is gone.
    await right.locator('del', { hasText: '会无限次' }).dblclick();
    await right.locator('del', { hasText: '会无限次' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Comment' }).click();
    await page.getByText(/artifacts\/docs\/design\.md, the change [0-9a-f]{7} of \d{4}-\d\d-\d\d \d\d:\d\d, text it removed/).waitFor();
    await page.getByRole('textbox', { name: 'Comment' }).fill('为什么改掉？');
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: /Review · 1 comment/ }).waitFor();

    // Side by side: the version before on the left with what was taken out, this one on the right with what was put in.
    await right.getByRole('button', { name: 'Side by side' }).click();
    await right.locator('[data-side=old] del', { hasText: '会无限次' }).waitFor();
    await right.locator('[data-side=new] ins', { hasText: '最多' }).waitFor();
    expect(await right.locator('[data-side=old] ins, [data-side=new] del').count()).toBe(0);
    if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, 'h4-split.png') });
    await right.getByRole('button', { name: 'Inline' }).click();

    // On to the change after it, user's own, and back to the file.
    await right.getByRole('button', { name: 'The change after' }).click();
    await right.locator('ins', { hasText: '毫秒，之后每次翻倍' }).waitFor();
    await right.getByText(/Edited on the page/).waitFor();
    if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, 'h3-mine.png') });
    await right.getByRole('button', { name: 'Back to the file' }).click();
    await right.getByText('毫秒，之后每次翻倍').waitFor();
    expect(await right.locator('ins, del, [data-diff]').count()).toBe(0);
    expect(errors).toEqual([]);
  }, 60_000);
});
