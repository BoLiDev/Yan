import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ArtifactFile, WriteResult } from '../lib/api';
import { detail, draw, have, index, reset, serve, status, task, type Asked } from '../testing/serve';
import { Middle } from '../panes/Middle';
import { ArtifactActModal } from './ArtifactMenu';

// The vault as the page has it, so nothing is fetched again after the save.
const saved: WriteResult = { ok: true, warning: null, status: status() };
const file = (path: string): ArtifactFile => ({ path, sha: path, size: 1, added: 0, changed: 0, commit: 'c1' });
const posted = (asked: readonly Asked[], path: string): unknown[] => asked.filter((a) => a.method === 'POST' && a.path === path).map((a) => a.body);

/** A task's column, its artifacts a file in a folder and one beside it, with the box their menu opens; the page at `hash`. */
async function aTask(routes: Parameters<typeof serve>[0] = {}, hash = '#/t/t1') {
  const asked = serve({ '/api/terminals': Response.json({}), ...routes });
  have(index([task('t1', 'pay retries')]), [detail('t1', { files: [file('docs/notes.md'), file('shot.png')] })]);
  location.hash = hash;
  const screen = await draw(<><Middle /><ArtifactActModal /></>);
  return { asked, screen };
}

describe("an artifact's menu in a task's artifacts", () => {
  afterEach(reset);

  it('opens a folder where it is, and closes it, at a click on it, the page staying where it was', async () => {
    const { screen } = await aTask({}, '#/t/t1/log');
    const folder = screen.getByRole('treeitem', { name: /docs/ });
    expect(screen.getByRole('treeitem', { name: /notes\.md/ }).elements()).toEqual([]);
    await folder.click();
    await expect.element(screen.getByRole('treeitem', { name: /notes\.md/ })).toBeVisible();
    expect(location.hash).toBe('#/t/t1/log');
    await folder.click();
    await expect.poll(() => screen.getByRole('treeitem', { name: /notes\.md/ }).elements().length).toBe(0);
    expect(location.hash).toBe('#/t/t1/log');
  });

  it('renames a file from a box that starts with its name, says in the box why serve refused, and follows the file it was showing', async () => {
    let refuse = true;
    const { asked, screen } = await aTask({
      'POST /api/artifact/rename': () => (refuse ? new Response('there is already a plan.md there', { status: 409 }) : Response.json(saved)),
    }, '#/t/t1/a/docs/notes.md');
    await screen.getByRole('treeitem', { name: /docs/ }).click();
    await screen.getByRole('treeitem', { name: /notes\.md/ }).click({ button: 'right' });
    await screen.getByRole('menuitem', { name: 'Rename' }).click();
    const box = screen.getByRole('alertdialog');
    const name = box.getByRole('textbox', { name: 'Name' });
    await expect.element(name).toHaveValue('notes.md');
    // Nothing to rename to yet.
    await expect.element(box.getByRole('button', { name: 'Rename' })).toBeDisabled();

    // Typed over what is selected, which is the name and not its ending.
    await userEvent.keyboard('plan{Enter}');
    await expect.element(box.getByRole('alert')).toHaveTextContent('there is already a plan.md there');
    await expect.element(box).toBeVisible();

    refuse = false;
    // Back in the name, to be typed over again.
    await expect.element(name).toHaveFocus();
    await userEvent.keyboard('findings');
    await box.getByRole('button', { name: 'Rename' }).click();
    await expect.poll(() => screen.getByRole('alertdialog').query()).toBeNull();
    expect(posted(asked, '/api/artifact/rename')).toEqual([
      { task: 't1', path: 'docs/notes.md', name: 'plan.md' },
      { task: 't1', path: 'docs/notes.md', name: 'findings.md' },
    ]);
    expect(location.hash, 'the page shows it under its new name').toBe('#/t/t1/a/docs/findings.md');
  });

  it('deletes a folder only once that is confirmed, and leaves a page that showed something in it', async () => {
    const { asked, screen } = await aTask({ 'POST /api/artifact/remove': Response.json(saved) }, '#/t/t1/a/docs/notes.md');
    await screen.getByRole('treeitem', { name: /docs/ }).click({ button: 'right' });
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    const box = screen.getByRole('alertdialog');
    await expect.element(box.getByText(/all it holds/)).toBeVisible();
    expect(posted(asked, '/api/artifact/remove'), 'nothing before it is confirmed').toEqual([]);

    await box.getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => posted(asked, '/api/artifact/remove')).toEqual([{ task: 't1', path: 'docs' }]);
    await expect.poll(() => location.hash).toBe('#/t/t1');
  });
});
