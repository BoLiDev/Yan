/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/** A picture of one pixel: all the page needs to show one. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

let served: Served;

beforeAll(async () => {
  const v = await vault((home) => {
    write(home, 'tasks/t001/task.json', taskJson('t001', 'pay retries'));
    write(home, 'tasks/t001/artifacts/c4/checkout.png', PIXEL);
  });
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

describe('a picture', () => {
  it('fills the screen with F, and gives the page back with F again', async () => {
    const { page, errors } = await open(served.url('/#/t/t001/a/c4/checkout.png'));
    await page.getByRole('main').getByRole('img', { name: 'checkout.png' }).waitFor();
    const full = (): Promise<string | null> => page.evaluate(() => document.fullscreenElement?.querySelector('img')?.alt ?? null);
    await page.keyboard.press('f');
    await expect.poll(full).toBe('checkout.png');
    await page.keyboard.press('f');
    await expect.poll(full).toBeNull();
    expect(errors).toEqual([]);
  });
});
