/// <reference lib="dom" />
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { AGENT_PANE, startFakeHerdr, type FakeHerdr } from '../helpers/fake-herdr.js';
import { cleanupTempDirs, fxGit, runYan } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * What a task's agent is up to, at a glance: told at the page's top right
 * as it finishes or comes to wait on `user`, listed in Latest, marked on
 * the task list and on the rail it folds to, where what it said with `yan
 * say` comes in a bubble, and no longer news once its terminal is typed in. herdr is the stand-in (tests/helpers/fake-herdr.ts),
 * whose agent a test moves from one status to the next.
 */

let served: Served;
let h: FakeHerdr;
let home = '';

beforeAll(async () => {
  h = await startFakeHerdr({ version: '0.9.5' });
  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', 'pay retries'));
    write(dir, 'tasks/t002/task.json', taskJson('t002', 'export orders'));
  });
  home = v.home;
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
    const { page } = await open(served.url('/#/latest'));
    const latest = page.getByRole('complementary', { name: 'Latest' });
    await latest.getByTitle('pay retries · agent at work').waitFor({ timeout: 20_000 });

    h.agentIs(AGENT_PANE, 'done');
    await page.getByText('Its agent has finished.').waitFor({ timeout: 20_000 });
    await latest.getByRole('link', { name: /pay retries.*now/ }).getByTitle('agent finished', { exact: true }).waitFor({ timeout: 10_000 });
    await expect.poll(() => tasks(page).getByTitle('agent finished', { exact: true }).count()).toBe(1);

    await page.getByRole('button', { name: 'Open terminal' }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/t/t001/terminal');
    await page.getByRole('group', { name: 'Agent', exact: true }).click();
    await expect.poll(() => tasks(page).getByTitle('agent finished', { exact: true }).count()).toBe(0);
  });

  it('is told when it comes to wait on the user, and stays marked until it is answered', async () => {
    h.agentIs(AGENT_PANE, 'working');
    const { page } = await open(served.url('/#/latest'));
    const latest = page.getByRole('complementary', { name: 'Latest' });
    await latest.getByTitle('pay retries · agent at work').waitFor({ timeout: 20_000 });

    h.agentIs(AGENT_PANE, 'blocked');
    await page.getByText('Its agent needs you: a question or a permission.').waitFor({ timeout: 20_000 });
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

  it('says what it said as the turn ended in a bubble from its square on the rail, which opens its terminal', async () => {
    h.agentIs(AGENT_PANE, 'working');
    const { page } = await open(served.url('/#/t/t002'));
    await page.getByRole('button', { name: 'Hide the task list' }).click();
    const rail = tasks(page);
    await rail.getByRole('link', { name: 'pay retries · agent at work' }).waitFor({ timeout: 20_000 });
    expect(await rail.getByRole('link', { name: 'pay retries · agent at work' }).textContent()).toBe('P');

    h.agentIs(AGENT_PANE, 'done');
    const bubble = page.getByRole('status', { name: 'pay retries' });
    await bubble.getByLabel('typing').waitFor({ timeout: 20_000 });
    // Said, then committed here as the hook commits the vault at the turn's end; serve reads this vault's HEAD.
    expect((await runYan(home, ['say', 'Retries are in; the PR waits on your review.'], { YAN_TASK: 't001' })).code).toBe(0);
    await fxGit(['commit', '-q', '-am', 't001'], home);
    await bubble.getByText('Retries are in; the PR waits on your review.').waitFor({ timeout: 20_000 });
    expect(await page.getByText('Its agent has finished.').count(), 'told on the rail, not in a toast').toBe(0);

    await bubble.getByRole('button', { name: /Retries are in/ }).click();
    await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/t/t001/terminal');
    await rail.getByRole('button', { name: 'Show the task list' }).click();
  });
});
