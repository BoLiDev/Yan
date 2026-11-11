/// <reference lib="dom" />
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/fixtures.js';
import { closeBrowser, open, push, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * Mermaid in a Markdown artifact: a fence drawn as its diagram where the
 * file is read, and, in a change that touched it, drawn as it was and as it
 * is.
 */

let served: Served;
const FILE = 'tasks/t001/artifacts/docs/flow.md';
const doc = (flow: string, more = ''): string => `# 支付重试流程\n\n用户付款失败后的处理：\n\n\`\`\`mermaid\n${flow}\`\`\`\n\n以上是主流程。${more}\n`;
const V1 = doc('flowchart LR\n  A[付款失败] --> B{已重试 3 次?}\n  B -- 否 --> C[等待后重试]\n  C --> A\n  B -- 是 --> D[提示换卡]\n');
const V2 = doc('flowchart LR\n  A[付款失败] --> B{已重试 5 次?}\n  B -- 否 --> C[等待后重试]\n  C --> A\n  B -- 是 --> D[提示换卡]\n  D --> E[通知用户]\n', '\n\n```mermaid\nthis is not a diagram\n```');

beforeAll(async () => {
  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', '支付重试'));
    write(dir, FILE, V1);
  });
  write(v.elsewhere, FILE, V2);
  await push(v.elsewhere, 't001: turn ended');
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

describe('Mermaid in a Markdown artifact', () => {
  it('is drawn as its diagram where the file is read, and one that cannot be drawn stays as its source, saying why', async () => {
    const { page, errors } = await open(served.url('/#/t/t001/a/docs/flow.md'));
    const right = page.locator('#right');
    await right.locator('[data-diagram] svg').waitFor({ timeout: 30_000 });
    expect(await right.locator('[data-diagram] svg').count()).toBe(1);
    await right.locator('[data-diagram] svg').getByText('通知用户').waitFor();
    await right.getByText(/Mermaid cannot draw this/).waitFor();
    await right.locator('pre').getByText('this is not a diagram').waitFor();
    if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, 'mermaid.png') });
    expect(errors).toEqual([]);
  }, 60_000);

  it('is drawn as it was and as it is in a change that touched it, each named, with its source compared under it', async () => {
    const { page, errors } = await open(served.url('/#/t/t001/a/docs/flow.md'));
    const right = page.locator('#right');
    await right.locator('[data-diagram] svg').waitFor({ timeout: 30_000 });
    await right.getByRole('button', { name: 'History' }).click();
    await page.getByRole('menuitem').first().click();
    await right.getByRole('button', { name: 'Inline' }).click();
    const before = right.locator('[data-diff=drawn][data-label=Before]');
    const after = right.locator('[data-diff=drawn][data-label=After]');
    await before.locator('svg').getByText('已重试 3 次?').waitFor({ timeout: 30_000 });
    await after.locator('svg').getByText('已重试 5 次?').waitFor();
    expect(await before.evaluate((el) => getComputedStyle(el).textDecorationLine), 'not struck through').toBe('none');
    await after.getByText('What changed in its source').click();
    await after.locator('details ins', { hasText: 'D --> E[通知用户]' }).waitFor();
    await page.mouse.move(700, 880);
    if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, 'mermaid-diff.png'), fullPage: false });

    await right.getByRole('button', { name: 'Side by side' }).click();
    await right.locator('[data-side=old] [data-diff=drawn] svg').getByText('已重试 3 次?').waitFor({ timeout: 30_000 });
    await right.locator('[data-side=new] [data-diff=drawn] svg').getByText('已重试 5 次?').waitFor();
    await page.mouse.move(700, 880);
    await page.waitForTimeout(300);
    if (process.env.YAN_SHOTS) await page.screenshot({ path: join(process.env.YAN_SHOTS, 'mermaid-split.png') });
    await right.getByRole('button', { name: 'Inline' }).click();
    expect(errors).toEqual([]);
  }, 90_000);
});
