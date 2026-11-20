/// <reference lib="dom" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { AGENT_PANE, startFakeHerdr, type FakeHerdr } from '../helpers/fake-herdr.js';
import { cleanupTempDirs } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * What a task's agent is up to, at a glance: told at the page's top right
 * as it finishes or comes to wait on `user`, marked on
 * the task list and on the rail it folds to, where it is told in a bubble, and no longer news once its terminal is typed in. herdr is the stand-in (tests/helpers/fake-herdr.ts),
 * whose agent a test moves from one status to the next.
 */

let served: Served;
let h: FakeHerdr;

beforeAll(async () => {
  h = await startFakeHerdr({ version: '0.9.5' });
  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', 'pay retries'));
    write(dir, 'tasks/t002/task.json', taskJson('t002', 'export orders'));
    write(dir, 'tasks/t003/task.json', taskJson('t003', 'sync invoices', { resources: { cloud: 'https://claude.ai/code/session_x' }, resourceKinds: { cloud: 'run' } }));
  });
  mkdirSync(join(v.home, '.machine'), { recursive: true });
  writeFileSync(join(v.home, '.machine', 'config.json'), JSON.stringify({ version: 1, vaults: {}, clones: {}, terminals: [h.terminal(v.home, 't001')] }));
  served = await serve(v.home, { HERDR_BIN_PATH: h.bin });
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  await h?.close();
  cleanupTempDirs();
});

const tasks = (page: Page) => page.getByRole('navigation', { name: 'Tasks' });

describe('a task\'s agent, at a glance', () => {
  it('is told at the top right as it finishes, its terminal a click away, and is no longer news once that terminal is typed in', async () => {
    h.agentIs(AGENT_PANE, 'working');
    // Another task is being read: nothing is told of the one that is.
    const { page } = await open(served.url('/#/t/t002'));
    await tasks(page).getByTitle(/pay retries.*agent at work/).waitFor({ timeout: 20_000 });

    h.agentIs(AGENT_PANE, 'done');
    await page.getByText('Its agent has finished.').waitFor({ timeout: 20_000 });
    await expect.poll(() => tasks(page).getByTitle('agent finished', { exact: true }).count()).toBe(1);

    await page.getByRole('button', { name: 'Open terminal' }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/t/t001/terminal');
    await page.getByRole('group', { name: 'Agent', exact: true }).click();
    await expect.poll(() => tasks(page).getByTitle('agent finished', { exact: true }).count()).toBe(0);
  });

  it('tells it in a toast with no button to close it, which a swipe to the side sends off', async () => {
    h.agentIs(AGENT_PANE, 'working');
    const { page } = await open(served.url('/#/t/t002'));
    await tasks(page).getByTitle(/pay retries.*agent at work/).waitFor({ timeout: 20_000 });
    h.agentIs(AGENT_PANE, 'done');
    const told = page.getByText('Its agent has finished.');
    await told.waitFor({ timeout: 20_000 });
    expect(await page.getByRole('button', { name: 'Close toast' }).count()).toBe(0);
    // Taken by its words, as a hand would take it: they are not selected by the drag, which would hold it where it is.
    const at = (await told.boundingBox()) as { x: number; y: number; width: number; height: number };
    await page.mouse.move(at.x + 20, at.y + at.height / 2);
    await page.mouse.down();
    await page.mouse.move(at.x + 240, at.y + at.height / 2, { steps: 10 });
    await page.mouse.up();
    await told.waitFor({ state: 'detached', timeout: 5000 });
  });

  it('is told when it comes to wait on the user, and stays marked until it is answered', async () => {
    h.agentIs(AGENT_PANE, 'working');
    const { page } = await open(served.url('/#/t/t002'));
    await tasks(page).getByTitle(/pay retries.*agent at work/).waitFor({ timeout: 20_000 });

    h.agentIs(AGENT_PANE, 'blocked');
    await page.getByText('Its agent needs you.').waitFor({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Open terminal' }).click();
    await page.getByRole('group', { name: 'Agent', exact: true }).click();
    await page.waitForTimeout(2500);
    expect(await tasks(page).getByTitle('agent needs you', { exact: true }).count()).toBe(1);
  });

  it('is not told while its task is the one being read, its Terminal row marked instead', async () => {
    h.agentIs(AGENT_PANE, 'working');
    const { page } = await open(served.url('/#/t/t001'));
    const column = page.getByRole('complementary', { name: 'Task' });
    await tasks(page).getByTitle(/pay retries.*agent at work/).waitFor({ timeout: 20_000 });

    h.agentIs(AGENT_PANE, 'done');
    await column.getByRole('link', { name: /Terminal/ }).getByTitle('agent finished', { exact: true }).waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1000);
    expect(await page.getByText('Its agent has finished.').count()).toBe(0);
  });

  it('shows on the rail the task list folds to, every open task a click away', async () => {
    h.agentIs(AGENT_PANE, 'working');
    const { page } = await open(served.url('/#/t/t002'));
    await page.getByRole('button', { name: 'Hide the task list' }).click();
    const rail = tasks(page);
    await rail.getByRole('link', { name: 'pay retries · agent at work' }).waitFor({ timeout: 20_000 });
    expect(await rail.getByRole('link', { name: 'export orders' }).getAttribute('aria-current')).toBe('page');

    await rail.getByRole('link', { name: 'pay retries · agent at work' }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/t\/t001/);
    await rail.getByRole('button', { name: 'Show the task list' }).click();
    await tasks(page).getByRole('button', { name: 'Hide the task list' }).waitFor();
  });

  it('says that it finished in a bubble from its square on the rail, which opens its terminal', async () => {
    h.agentIs(AGENT_PANE, 'working');
    const { page } = await open(served.url('/#/t/t002'));
    await page.getByRole('button', { name: 'Hide the task list' }).click();
    const rail = tasks(page);
    await rail.getByRole('link', { name: 'pay retries · agent at work' }).waitFor({ timeout: 20_000 });
    expect(await rail.getByRole('link', { name: 'pay retries · agent at work' }).textContent()).toBe('P');

    h.agentIs(AGENT_PANE, 'done');
    const bubble = page.getByRole('status', { name: 'pay retries' });
    await bubble.getByText('Finished.').waitFor({ timeout: 20_000 });
    expect(await page.getByText('Its agent has finished.').count(), 'told on the rail, not in a toast').toBe(0);

    await bubble.getByRole('button', { name: /Finished/ }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/t/t001/terminal');
    await rail.getByRole('button', { name: 'Show the task list' }).click();
  });
});
