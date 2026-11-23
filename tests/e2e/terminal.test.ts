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

  it('takes what is on the clipboard as a paste is made, not as it is a moment later, when a tool that types by pasting has put the old back', async () => {
    const { page } = await open(served.url('/#/t/t001/terminal'));
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.getByRole('group', { name: 'Agent', exact: true }).click();
    const before = h.received(AGENT_PANE).length;
    // As such a tool does: its words on the clipboard, the paste, and what was there before put back at once.
    await page.evaluate(() => navigator.clipboard.writeText('what was just said'));
    await page.keyboard.press('Control+V');
    await page.evaluate(() => navigator.clipboard.writeText('what was copied an hour ago'));
    await expect.poll(() => h.received(AGENT_PANE).slice(before), { timeout: 10_000 }).toEqual([{ paste: 'what was just said', keys: [] }]);
  });

  it('sends a burst of keys together, in the order they were pressed, not a request for each', async () => {
    const page = await onTerminal();
    await pane(page, 'Agent').click();
    const before = h.received(AGENT_PANE).length;
    // As a tool that takes dictation takes back what it typed: Backspace upon Backspace, faster than any hand.
    await page.evaluate(() => {
      const field = document.querySelector('.xterm-helper-textarea') as HTMLElement;
      for (let i = 0; i < 40; i++) field.dispatchEvent(new KeyboardEvent('keydown', { key: i === 39 ? 'Enter' : 'Backspace', keyCode: i === 39 ? 13 : 8, bubbles: true, cancelable: true }));
    });
    await expect.poll(() => h.received(AGENT_PANE).slice(before), { timeout: 10_000 }).toEqual([{ keys: [...Array.from({ length: 39 }, () => 'backspace'), 'enter'] }]);
  });

  it('keeps what an input method is composing inside the pane, wrapped, however long it is', async () => {
    const page = await onTerminal();
    await pane(page, 'Agent').click();
    const drawn = await page.evaluate(() => {
      const field = document.querySelector('.xterm-helper-textarea') as HTMLElement;
      // As speech taken down as it is said: one composition, its words growing.
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      field.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '说了很长很长的一段话，'.repeat(40) }));
      const view = document.querySelector('.composition-view') as HTMLElement;
      const host = view.closest('[data-term]') as HTMLElement;
      const [v, hst] = [view.getBoundingClientRect(), host.getBoundingClientRect()];
      const line = parseFloat(getComputedStyle(view).lineHeight);
      return { wide: v.width > (hst.right - v.left) / 2, inside: v.right <= hst.right + 1 && v.bottom <= hst.bottom + 1, lines: Math.round(v.height / line), shown: getComputedStyle(view).display };
    });
    expect(drawn.shown).toBe('block');
    expect(drawn.inside, 'not past the pane\'s edge').toBe(true);
    expect(drawn.lines, 'on as many lines as it takes').toBeGreaterThan(1);
    expect(drawn.wide, 'each line running to the pane\'s edge, not a word wide').toBe(true);
  });

  it('opens the task box at Ctrl+F while it is typed in a pane, the agent sent nothing, and leaves Ctrl+K and Ctrl+Shift+F to the agent', async () => {
    const page = await onTerminal();
    await pane(page, 'Agent').click();
    const got = (key: string): boolean => h.received(AGENT_PANE).some((r) => 'keys' in r && r.keys.includes(key));
    await page.keyboard.press('Control+f');
    await page.getByRole('dialog', { name: 'Go to a task' }).waitFor({ timeout: 10_000 });
    expect(got('ctrl+f')).toBe(false);
    await page.keyboard.press('Control+f');
    await page.getByRole('dialog', { name: 'Go to a task' }).waitFor({ state: 'hidden', timeout: 10_000 });
    await pane(page, 'Agent').click();
    await page.keyboard.press('Control+k');
    await page.keyboard.press('Control+Shift+F');
    await expect.poll(() => got('ctrl+k') && got('ctrl+f'), { timeout: 10_000 }).toBe(true);
    expect(await page.getByRole('dialog', { name: 'Go to a task' }).count()).toBe(0);
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

  it("stops the agent only when asked twice, by its tab's ×, closing its tab", async () => {
    const page = await onTerminal();
    await page.getByRole('tab', { name: /Agent/ }).getByRole('button', { name: 'Close Agent' }).click();
    expect(h.tabs()).toHaveLength(1);
    await page.getByRole('button', { name: 'Really stop the agent' }).click();
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
