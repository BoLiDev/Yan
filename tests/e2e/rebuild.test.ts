/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

let served: Served;
let home = '';

beforeAll(async () => {
  const v = await vault((dir) => write(dir, 'tasks/t001/task.json', taskJson('t001', 'pay retries')));
  home = v.home;
  served = await serve(home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

describe('a page open while yan is rebuilt', () => {
  it('loads the new build by itself once serve has restarted on it, where it was', async () => {
    const { page } = await open(served.url('/#/t/t001'));
    await page.getByRole('heading', { name: 'pay retries' }).first().waitFor();
    await page.evaluate(() => {
      (window as unknown as { loadedBefore: boolean }).loadedBefore = true;
    });
    write(home, 'dist/cli/newer.js', '// a newer build\n');
    await expect.poll(() => page.evaluate(() => (window as unknown as { loadedBefore?: boolean }).loadedBefore ?? false), { timeout: 30_000, interval: 500 }).toBe(false);
    expect(await page.evaluate(() => location.hash)).toBe('#/t/t001');
    await page.getByRole('heading', { name: 'pay retries' }).first().waitFor();
  });
});
