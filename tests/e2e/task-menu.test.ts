/// <reference lib="dom" />
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, fxGit } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

let served: Served;
let origin = '';

beforeAll(async () => {
  const v = await vault((home) => {
    write(home, 'tasks/t001/task.json', taskJson('t001', 'pay retries'));
    write(home, 'tasks/t001/problem.md', '# pay retries\n\nThey are not paid.\n');
  });
  origin = v.origin;
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

describe("a task's menu", () => {
  it('renames the task from its row, pushes the new title, and the list shows it called that', async () => {
    const { page, errors } = await open(served.url('/#/t/t001'));
    const list = page.getByRole('navigation', { name: 'Tasks' });
    await list.getByRole('link', { name: /pay retries/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    const title = page.getByRole('alertdialog').getByRole('textbox', { name: 'Title' });
    await title.fill('payment retries');
    await page.keyboard.press('Enter');
    await page.getByRole('alertdialog').waitFor({ state: 'detached' });

    await list.getByRole('link', { name: /payment retries/ }).waitFor();
    const pushed = JSON.parse((await fxGit(['show', 'main:tasks/t001/task.json'], origin)).stdout) as { id: string; title: string };
    expect(pushed).toMatchObject({ id: 't001', title: 'payment retries' });
    expect(errors).toEqual([]);
  });
});
