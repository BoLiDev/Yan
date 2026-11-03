/// <reference lib="dom" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupTempDirs, fxGit } from '../helpers/fixtures.js';
import { closeBrowser, open, serve, taskJson, vault, write, type Served } from './harness.js';

/**
 * A Markdown artifact edited in its source on the page: written where it is
 * shown, saved with ⌘S, committed here and drawn as saved at once, and
 * pushed on its own afterwards.
 */

let served: Served;
let home = '';
let origin = '';

beforeAll(async () => {
  const v = await vault((dir) => {
    write(dir, 'tasks/t001/task.json', taskJson('t001', 'pay retries'));
    write(dir, 'tasks/t001/artifacts/docs/notes.md', '# Notes\n\nThe retry pays twice.\n');
  });
  home = v.home;
  origin = v.origin;
  served = await serve(v.home);
});

afterAll(async () => {
  await closeBrowser();
  await served?.stop();
  cleanupTempDirs();
});

describe('a Markdown artifact', () => {
  it('is edited in its source and saved with ⌘S, drawn as saved at once, committed here and pushed later', async () => {
    const { page, errors } = await open(served.url('/#/t/t001/a/docs/notes.md'));
    const right = page.locator('#right');
    await right.getByText('The retry pays twice.').waitFor();
    await right.getByRole('button', { name: 'Source' }).click();
    const area = right.getByRole('textbox', { name: /docs\/notes\.md/ });
    await area.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('It is paid once now.');
    await page.keyboard.press('Control+s');
    await right.getByText('Type to edit').waitFor();
    expect(readFileSync(join(home, 'tasks/t001/artifacts/docs/notes.md'), 'utf8')).toBe('# Notes\n\nThe retry pays twice.\nIt is paid once now.');
    expect((await fxGit(['log', '-1', '--format=%s'], home)).stdout.trim()).toBe('t001: docs/notes.md edited in yan serve');

    await right.getByRole('button', { name: 'Rendered' }).click();
    await right.getByText('It is paid once now.').waitFor();
    await expect.poll(async () => (await fxGit(['show', 'main:tasks/t001/artifacts/docs/notes.md'], origin)).stdout, { timeout: 20_000 }).toContain('It is paid once now.');
    expect(errors).toEqual([]);
  }, 40_000);
});
