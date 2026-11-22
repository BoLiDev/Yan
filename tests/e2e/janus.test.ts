import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDirs } from '../helpers/fixtures.js';
import { startFakeHerdr, type FakeHerdr } from '../helpers/fake-herdr.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * Janus, the agent kept beside the tasks, as `yan serve` keeps it up: its
 * task made and its agent started as serve starts, and on the page a click
 * from anywhere, off the list of tasks. herdr is the one stand-in.
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
  it('is started with serve in a herdr tab of its own, and is a click away over the task list, at its terminal, never a row of the list', async () => {
    await expect.poll(() => h.tabs().find((t) => t.label === 'Janus'), { timeout: 15_000 }).toBeDefined();
    const tab = h.tabs().find((t) => t.label === 'Janus');
    await expect.poll(() => h.received(tab?.panes[0] ?? '').map((r) => ('text' in r ? r.text : '')).join(''), { timeout: 10_000 }).toMatch(/yan\.mjs --janus\r$/);

    const { page, errors } = await open(served.url('/#/t/t001'));
    await page.getByRole('link', { name: /pay retries/ }).first().waitFor({ timeout: 15_000 });
    expect(await page.locator('nav a[href="#/t/janus"], aside a[href="#/t/janus"]').count(), 'no row of its own').toBe(0);
    await page.locator('a[aria-label="Janus"]').click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/t/janus/terminal');
    await page.getByRole('group', { name: 'Agent', exact: true }).waitFor({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Janus' }).first().isVisible()).resolves.toBe(true);
    expect(errors).toEqual([]);
    expect(h.tabs().filter((t) => t.label === 'Janus'), 'one tab, however often it is looked at').toHaveLength(1);
  });
});
