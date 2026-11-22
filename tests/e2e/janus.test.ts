import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs } from '../helpers/fixtures.js';
import { startFakeHerdr, type FakeHerdr } from '../helpers/fake-herdr.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * Janus, the agent kept beside the tasks, on the page: its task made as
 * `yan serve` starts, its agent started from its own page when asked, and
 * its mark a click from anywhere, off the list of tasks. herdr is the one
 * stand-in.
 */

let served: Served;
let h: FakeHerdr;

beforeAll(async () => {
  h = await startFakeHerdr({ version: '0.9.5' });
  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', 'pay retries'));
  });
  mkdirSync(join(v.home, '.machine'), { recursive: true });
  writeFileSync(join(v.home, '.machine', 'config.json'), JSON.stringify({ version: 1, vaults: {}, clones: {}, terminals: [] }));
  served = await serve(v.home, { HERDR_BIN_PATH: h.bin }, true);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  await h?.close();
  cleanupTempDirs();
});

describe.skipIf(process.platform === 'win32')('Janus on the page', () => {
  it('is not started by serve: its mark is grey over the task list, opens its page, which has no overview or log, and it is started there in a herdr tab of its own', async () => {
    const { page, errors } = await open(served.url('/#/t/t001'));
    await page.getByRole('link', { name: /pay retries/ }).first().waitFor({ timeout: 15_000 });
    expect(h.tabs().some((t) => t.label === 'Janus'), 'nothing started by serve').toBe(false);
    const mark = page.locator('a[aria-label^="Janus"]');
    expect(await mark.getAttribute('aria-label')).toBe('Janus, not started');
    expect(await page.locator('a[href="#/t/janus"]').count(), 'no row of its own').toBe(0);

    await mark.click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/t/janus/terminal');
    const column = page.getByRole('complementary', { name: 'Task' });
    await column.getByRole('heading', { name: 'Janus' }).waitFor();
    expect(await column.getByRole('link').allInnerTexts()).toEqual(['Terminal']);

    await page.getByRole('button', { name: 'Start Janus' }).click();
    await expect.poll(() => h.tabs().find((t) => t.label === 'Janus'), { timeout: 15_000 }).toBeDefined();
    const tab = h.tabs().find((t) => t.label === 'Janus');
    await expect.poll(() => h.received(tab?.panes[0] ?? '').map((r) => ('text' in r ? r.text : '')).join(''), { timeout: 10_000 }).toMatch(/yan\.mjs --janus\r$/);
    await page.getByRole('group', { name: 'Agent', exact: true }).waitFor({ timeout: 15_000 });
    await expect.poll(() => mark.getAttribute('aria-label'), { timeout: 15_000 }).toBe('Janus');
    expect(errors).toEqual([]);
  });
});
