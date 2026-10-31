/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs } from '../helpers/fixtures.js';
import { closeBrowser, open, push, serve, taskJson, vault, write, type Served } from './harness.js';

let served: Served;
let elsewhere = '';

beforeAll(async () => {
  const v = await vault((home) => {
    write(home, 'tasks/t001/task.json', taskJson('t001', 'pay retries'));
    write(home, 'tasks/t001/problem.md', '# pay retries\n\nThey are not paid.\n');
    write(home, 'tasks/t001/artifacts/notes/old.md', '# old notes\n');
  });
  elsewhere = v.elsewhere;
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

describe('what an agent pushes, on a page left open', () => {
  it('shows up without a reload, marked new, and opening it clears the mark', async () => {
    const { page, errors } = await open(served.url('/#/latest'));
    await page.getByText('When an agent pushes something new, it shows up here.').waitFor();
    // What was there when the page first opened is not news.
    await expect(page.getByTitle(/with something new/).count()).resolves.toBe(0);

    write(elsewhere, 'tasks/t001/artifacts/notes/new.md', '# new notes\n\nbrand new words\n');
    await push(elsewhere, 't001: new notes');

    const badge = page.getByTitle(/with something new/);
    await badge.waitFor({ timeout: 20_000 });
    expect(await badge.textContent()).toBe('1');
    // The task's row in the list says what came, as tags.
    await expect(page.getByRole('navigation', { name: 'Tasks' }).getByTitle('1 added').count()).resolves.toBe(1);

    await page.getByRole('button', { name: /pay retries/ }).click();
    await page.getByRole('link', { name: /new\.md/ }).click();
    await page.getByText('brand new words').waitFor();
    await badge.waitFor({ state: 'detached', timeout: 10_000 });
    expect(errors).toEqual([]);
  });
});
