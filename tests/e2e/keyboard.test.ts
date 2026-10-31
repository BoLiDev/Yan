/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { cleanupTempDirs } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

let served: Served;

beforeAll(async () => {
  const v = await vault((home) => {
    write(home, 'tasks/t001/task.json', taskJson('t001', 'pay retries'));
    write(home, 'tasks/t001/problem.md', '# pay retries\n\nThey are not paid.\n');
    write(home, 'tasks/t002/task.json', taskJson('t002', 'export csv'));
  });
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

/**
 * Where the keyboard is, once it has settled: inside the box over the page,
 * and where the page itself is. A box's focus trap may pass the keyboard
 * through a guard beside it on its way round, so it is asked until it stays.
 */
async function where(page: Page): Promise<{ inBox: boolean; hash: string }> {
  const now = () => page.evaluate(() => ({ inBox: !!document.activeElement?.closest('[role="dialog"], [role="alertdialog"]'), hash: location.hash }));
  await expect.poll(async () => (await now()).inBox, { timeout: 1000 }).toBe(true).catch(() => undefined);
  return now();
}

async function onTask(): Promise<Page> {
  const { page } = await open(served.url('/#/t/t001'));
  await page.getByText('They are not paid.').waitFor();
  return page;
}

describe('a box over the page', () => {
  it("keeps the keyboard while it is open, whatever Tab is pressed on, and leaves the page where it was", async () => {
    const page = await onTask();
    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByRole('dialog').waitFor();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press(i % 2 === 0 ? 'Tab' : 'Shift+Tab');
      await page.keyboard.press('Tab');
      expect(await where(page)).toEqual({ inBox: true, hash: '#/t/t001' });
    }
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
  });

  it('asks a question that keeps the keyboard until it is answered or let go', async () => {
    const page = await onTask();
    await page.getByRole('button', { name: 'Delete d1' }).click();
    await page.getByRole('alertdialog').waitFor();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      expect(await where(page)).toEqual({ inBox: true, hash: '#/t/t001' });
    }
    await page.keyboard.press('Escape');
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });
    await page.getByText('it works').waitFor();
  });

  it('moves ⌘K\'s pick with Tab, and the page only when a task is picked', async () => {
    const page = await onTask();
    await page.keyboard.press('Control+K');
    await page.getByRole('dialog', { name: 'Go to a task' }).waitFor();
    await page.keyboard.type('export');
    await page.keyboard.press('Tab');
    expect(await where(page)).toEqual({ inBox: true, hash: '#/t/t001' });
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/t/t002');
  });
});
