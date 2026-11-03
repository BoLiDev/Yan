/// <reference lib="dom" />
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, fxGit } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * `user`'s drafts on the page: the vault's, opened from the task list in a
 * box of their own, read and written in one place. What is written is on
 * this machine's disk as the typing pauses, nothing waiting on git; the
 * box closing pushes it.
 */

let served: Served;
let home = '';
let origin = '';

/** A one-pixel PNG, as a screenshot pasted would be. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

beforeAll(async () => {
  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', 'pay retries'));
    write(dir, 'drafts/2026-10-30_090000-retry-ideas.md', '# Retry ideas\n\nBack off **twice** before giving up.\n\n- one\n- two\n');
    // One from when drafts were kept per task, read where it is.
    write(dir, 'tasks/t001/drafts/2026-09-01_080000.md', '# Old note from t001\n\nkept with its task\n');
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

/** A file as the vault's origin has it, or undefined when it has none. */
async function pushed(path: string): Promise<string | undefined> {
  const r = await fxGit(['show', `main:${path}`], origin);
  return r.code === 0 ? r.stdout : undefined;
}

/** A draft's file on this machine's disk, or undefined. */
const onDisk = (rel: string): string | undefined => (existsSync(join(home, rel)) ? readFileSync(join(home, rel), 'utf8') : undefined);

describe('the drafts', () => {
  it('open on the newest, written where a click falls, on disk as the typing pauses and pushed once the box closes', async () => {
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
    const file = 'drafts/2026-10-30_090000-retry-ideas.md';
    await expect.poll(() => onDisk(file), { timeout: 5000 }).toBe('# Retry ideas\n\nBack off **twice** before giving up.\n\n- one\n- two and three\n');
    expect(await pushed(file), 'not pushed while it is written').not.toContain('three');

    // Escape stops writing and leaves the box open; again, it closes the box, which pushes what was written.
    await page.keyboard.press('Escape');
    await box.getByRole('document').getByText('two and three').waitFor();
    // At once again: nothing to wait for.
    await box.getByRole('document').getByText('two and three').click();
    await expect.poll(() => area.evaluate((el) => el === document.activeElement)).toBe(true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await box.waitFor({ state: 'hidden' });
    await expect.poll(() => pushed(file), { timeout: 15_000 }).toContain('- two and three');
    expect(errors).toEqual([]);
  });

  it('take a new one, named for its first line and written on as it gets it, and delete one from its menu at once, once asked', async () => {
    const { page, errors } = await open(served.url('/'));
    await page.getByRole('navigation', { name: 'Tasks' }).getByRole('button', { name: 'Drafts' }).click();
    const box = page.getByRole('dialog');
    const list = box.getByRole('complementary', { name: 'Drafts' });
    await list.getByRole('button', { name: 'New' }).click();
    await page.keyboard.type('# Pricing questions\n\nask about tiers');
    await list.getByText('Pricing questions').waitFor();
    // Named, it is written on where it was, the caret kept.
    await page.keyboard.type(' and seats');
    const named = async (): Promise<string | undefined> => readdirSync(join(home, 'drafts')).find((f) => /^\d{4}-\d{2}-\d{2}_\d{6}-pricing-questions\.md$/.test(f));
    await expect.poll(async () => onDisk(`drafts/${await named()}`), { timeout: 5000 }).toBe('# Pricing questions\n\nask about tiers and seats\n');

    await list.getByText('Pricing questions').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const asked = page.getByRole('alertdialog');
    await asked.getByText('Delete “Pricing questions”?').waitFor();
    expect(await named(), 'not before it is answered').toBeDefined();
    await asked.getByRole('button', { name: 'Delete' }).click();
    expect(await list.getByText('Pricing questions').count(), 'gone from the list at once').toBe(0);
    await expect.poll(named).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it('keep a picture pasted into one beside it, named in it where the caret was, and drawn from there', async () => {
    const { page, errors } = await open(served.url('/'));
    await page.getByRole('navigation', { name: 'Tasks' }).getByRole('button', { name: 'Drafts' }).click();
    const box = page.getByRole('dialog');
    await box.getByRole('complementary', { name: 'Drafts' }).getByText('Old note from t001').click();
    await box.getByRole('document').getByText('kept with its task').click();
    const area = box.getByRole('textbox', { name: 'Draft' });
    await expect.poll(() => area.evaluate((el) => el === document.activeElement)).toBe(true);
    await area.evaluate((el, pixel) => {
      const bytes = Uint8Array.from(atob(pixel), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'shot.png', { type: 'image/png' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, PIXEL);
    await expect.poll(() => area.inputValue()).toContain('![](2026-09-01_080000/1.png)');
    expect(existsSync(join(home, 'tasks/t001/drafts/2026-09-01_080000/1.png')), 'kept beside the draft, where it is').toBe(true);

    await page.keyboard.press('Escape');
    const picture = box.getByRole('document').locator('img');
    await picture.waitFor();
    await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1);
    await expect.poll(() => onDisk('tasks/t001/drafts/2026-09-01_080000.md'), { timeout: 5000 }).toContain('![](2026-09-01_080000/1.png)');
    expect(errors).toEqual([]);
  });
});
