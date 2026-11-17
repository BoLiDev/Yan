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
    write(home, 'tasks/t002/task.json', taskJson('t002', 'export orders'));
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
  it('shows up without a reload, marked new beside its task and on the file, and opening the file clears the marks', async () => {
    // Opened at no task, the page goes to one: there is nowhere else to be.
    const { page, errors } = await open(served.url('/'));
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#\/t\/t00[12]$/);
    await page.goto(served.url('/#/t/t002'));
    const tasks = page.getByRole('navigation', { name: 'Tasks' });
    await tasks.getByRole('link', { name: /pay retries/ }).waitFor();
    // What was there when the page first opened is not news.
    expect(await tasks.getByTitle('1 added').count()).toBe(0);

    write(elsewhere, 'tasks/t001/artifacts/notes/new.md', '# new notes\n\nbrand new words\n');
    await push(elsewhere, 't001: new notes');
    // The task's row in the list says what came, as tags.
    await tasks.getByTitle('1 added').waitFor({ timeout: 20_000 });

    // Turned off in the settings, nothing is marked; turned on again, what was not looked at meanwhile still is.
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('switch', { name: 'Marks on what is new' }).click();
    await expect.poll(() => page.getByTitle('1 added').count()).toBe(0);
    await page.getByRole('switch', { name: 'Marks on what is new' }).click();
    await page.getByTitle('1 added').waitFor();
    await page.keyboard.press('Escape');

    await tasks.getByRole('link', { name: /pay retries/ }).click();
    const column = page.getByRole('complementary', { name: 'Task' });
    const fresh = column.getByText('new.md', { exact: true });
    await column.getByText('notes', { exact: true }).waitFor();
    // Its folder is opened, when it is not open already, to get to it.
    if (!(await fresh.isVisible())) await column.getByText('notes', { exact: true }).click();
    await column.getByTitle('new since your last look').waitFor();
    await fresh.click();
    await page.getByText('brand new words').waitFor();
    await expect.poll(() => column.getByTitle('new since your last look').count(), { timeout: 10_000 }).toBe(0);
    await page.goto(served.url('/#/t/t002'));
    await expect.poll(() => tasks.getByTitle('1 added').count(), { timeout: 10_000 }).toBe(0);
    expect(errors).toEqual([]);
  });
});
