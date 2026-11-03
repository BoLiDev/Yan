/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, fxGit } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * `user`'s drafts on the page: the vault's, opened from the task list in a
 * box of their own, read and written in one place, each change committed
 * and pushed.
 */

let served: Served;
let origin = '';

beforeAll(async () => {
  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', 'pay retries'));
    write(dir, 'drafts/2026-10-30_090000-retry-ideas.md', '# Retry ideas\n\nBack off **twice** before giving up.\n\n- one\n- two\n');
    // One from when drafts were kept per task, read where it is.
    write(dir, 'tasks/t001/drafts/2026-09-01_080000.md', '# Old note from t001\n\nkept with its task\n');
  });
  origin = v.origin;
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

/** A file as the vault's origin has it, or undefined when it has none. */
async function pushed(path: string): Promise<string | undefined> {
  const r = await fxGit(['show', `main:${path}`], origin);
  return r.code === 0 ? r.stdout : undefined;
}

describe('the drafts', () => {
  it('open from the task list on the newest, which a click on writes where it fell, saved and pushed once left', async () => {
    const { page, errors } = await open(served.url('/'));
    await page.getByRole('navigation', { name: 'Tasks' }).getByRole('button', { name: 'Drafts' }).click();
    const box = page.getByRole('dialog');
    const list = box.getByRole('complementary', { name: 'Drafts' });
    await list.getByText('Old note from t001').waitFor();
    expect(await list.getByRole('button').filter({ hasNotText: 'New' }).allTextContents()).toEqual([
      expect.stringMatching(/^Retry ideas/),
      expect.stringMatching(/^Old note from t001.*t001$/),
    ]);

    // Read, then written at the end of its last line, clicked past its last word.
    const two = box.getByRole('document').getByText('two', { exact: true });
    const at = await two.boundingBox();
    await page.mouse.click((at?.x ?? 0) + (at?.width ?? 0) - 4, (at?.y ?? 0) + (at?.height ?? 0) / 2);
    const area = box.getByRole('textbox', { name: 'Draft' });
    await expect.poll(() => area.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.type(' and three');
    expect(await area.inputValue()).toBe('# Retry ideas\n\nBack off **twice** before giving up.\n\n- one\n- two and three\n');

    // Escape stops writing, which saves it, and leaves the box open; again, it closes the box.
    await page.keyboard.press('Escape');
    await box.getByRole('document').getByText('two and three').waitFor();
    await expect.poll(() => pushed('drafts/2026-10-30_090000-retry-ideas.md'), { timeout: 15_000 }).toContain('- two and three');
    expect(await box.isVisible()).toBe(true);
    await page.keyboard.press('Escape');
    await box.waitFor({ state: 'hidden' });
    expect(errors).toEqual([]);
  });

  it('take a new one, named for its first line, and delete one from its menu in the list, once asked', async () => {
    const { page, errors } = await open(served.url('/'));
    await page.getByRole('navigation', { name: 'Tasks' }).getByRole('button', { name: 'Drafts' }).click();
    const box = page.getByRole('dialog');
    const list = box.getByRole('complementary', { name: 'Drafts' });
    await list.getByRole('button', { name: 'New' }).click();
    await page.keyboard.type('# Pricing questions\n\nask about tiers');
    // Left for another draft, it is kept.
    await list.getByText('Old note from t001').click();
    await list.getByText('Pricing questions').waitFor();
    const files = async (): Promise<string> => (await fxGit(['ls-tree', '--name-only', 'main', 'drafts/'], origin)).stdout;
    await expect.poll(files, { timeout: 15_000 }).toMatch(/drafts\/\d{4}-\d{2}-\d{2}_\d{6}-pricing-questions\.md/);

    // Its own menu, on a right click in the list, deletes it once asked.
    await list.getByText('Pricing questions').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const asked = page.getByRole('alertdialog');
    await asked.getByText('Delete “Pricing questions”?').waitFor();
    expect(await files(), 'not before it is answered').toMatch(/pricing-questions/);
    await asked.getByRole('button', { name: 'Delete' }).click();
    await list.getByText('Pricing questions').waitFor({ state: 'detached' });
    await expect.poll(files, { timeout: 15_000 }).not.toMatch(/pricing-questions/);
    expect(errors).toEqual([]);
  });
});
