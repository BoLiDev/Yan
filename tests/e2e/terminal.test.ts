/// <reference lib="dom" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Locator, Page } from 'playwright';
import { AGENT_PANE, SHELL_PANE, startFakeHerdr, type FakeHerdr } from '../helpers/fake-herdr.js';
import { cleanupTempDirs } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * A task's agent in a herdr pane, on the page: the pane drawn as herdr
 * streams it, typed into, split and closed from its menu, stopped, and a
 * new task started into a tab of its own. herdr is the one stand-in, a fake
 * that keeps what reached each pane (tests/helpers/fake-herdr.ts).
 */

let served: Served;
let h: FakeHerdr;
let home = '';

beforeAll(async () => {
  h = await startFakeHerdr({ version: '0.9.5' });
  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', 'pay retries'));
  });
  home = v.home;
  mkdirSync(join(home, '.machine'), { recursive: true });
  writeFileSync(join(home, '.machine', 'config.json'), JSON.stringify({ version: 1, vaults: {}, clones: {}, terminals: [h.terminal(home, 't001')] }));
  // Where serve finds herdr once the agent's own terminal is stopped and gone from this machine's config.
  served = await serve(home, { HERDR_BIN_PATH: h.bin });
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  await h?.close();
  cleanupTempDirs();
});

/** What has been typed into `pane`, as one string. */
const typed = (pane: string): string => h.received(pane).map((r) => ('text' in r ? r.text : '')).join('');

/** A pane of the tab as the page names it: the agent's, or a shell split off beside it. */
const pane = (page: Page, what: 'Agent' | 'Shell'): Locator => page.getByRole('group', { name: what, exact: true });

async function onTerminal(): Promise<Page> {
  const { page } = await open(served.url('/#/t/t001/terminal'));
  await page.locator('.xterm-rows').getByText('Do you want to proceed?').first().waitFor({ timeout: 20_000 });
  return page;
}

describe.skipIf(process.platform === 'win32')("a task's terminal on the page", () => {
  it('draws the agent\'s pane as herdr streams it, and what is typed in it reaches the pane', async () => {
    const page = await onTerminal();
    await pane(page, 'Agent').click();
    await page.keyboard.type('yes please');
    await expect.poll(() => typed(AGENT_PANE), { timeout: 10_000 }).toBe('yes please');
  });

  it('leaves Ctrl+K to the agent while it is typed in a pane, and opens the task box with Shift', async () => {
    const page = await onTerminal();
    await pane(page, 'Agent').click();
    await page.keyboard.press('Control+K');
    const killed = (): boolean => h.received(AGENT_PANE).some((r) => 'keys' in r && r.keys.includes('ctrl+k'));
    await expect.poll(killed, { timeout: 10_000 }).toBe(true);
    expect(await page.getByRole('dialog', { name: 'Go to a task' }).count()).toBe(0);
    await page.keyboard.press('ControlOrMeta+Shift+K');
    await page.getByRole('dialog', { name: 'Go to a task' }).waitFor({ timeout: 10_000 });
  });

  it("splits a pane from its own menu, and closes a shell but never the agent's pane", async () => {
    const page = await onTerminal();
    const panes = (): string[] => h.tabs()[0]?.panes.slice() ?? [];
    expect(panes()).toEqual([AGENT_PANE, SHELL_PANE]);

    await pane(page, 'Agent').click({ button: 'right' });
    expect(await page.getByRole('menuitem', { name: 'Close' }).count(), "the agent's pane offers no Close").toBe(0);
    await page.getByRole('menuitem', { name: 'Split down' }).click();
    await expect.poll(() => panes().length, { timeout: 10_000 }).toBe(3);

    await expect.poll(() => pane(page, 'Shell').count(), { timeout: 10_000 }).toBe(2);
    await pane(page, 'Shell').last().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Close' }).click();
    await expect.poll(() => panes().length, { timeout: 10_000 }).toBe(2);
    expect(panes()).toContain(AGENT_PANE);
  });

  it('stops the agent only when asked twice, closing its tab', async () => {
    const page = await onTerminal();
    await page.getByRole('button', { name: 'Stop' }).click();
    expect(h.tabs()).toHaveLength(1);
    await page.getByRole('button', { name: 'Really stop' }).click();
    await expect.poll(() => h.tabs().length, { timeout: 10_000 }).toBe(0);
    // Stopped, the task is one to go on with.
    await page.getByRole('button', { name: 'Continue' }).waitFor({ timeout: 10_000 });
  });

  it('starts a new task from the page in a new herdr tab named for it, and shows that tab', async () => {
    const { page } = await open(served.url('/#/latest'));
    await page.getByRole('button', { name: 'New task' }).click();
    await page.getByRole('textbox', { name: 'Title' }).fill('refund on cancel');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => location.hash), { timeout: 10_000 }).toMatch(/^#\/new\/new-[0-9a-f]{8}$/);
    const tab = h.tabs().find((t) => t.label === 'refund on cancel');
    expect(tab).toBeDefined();
    await expect.poll(() => typed(tab?.panes[0] ?? ''), { timeout: 10_000 }).toMatch(/yan\.mjs --new 'refund on cancel' --no-repo\r$/);
    await pane(page, 'Agent').waitFor({ timeout: 10_000 });
  });
});
