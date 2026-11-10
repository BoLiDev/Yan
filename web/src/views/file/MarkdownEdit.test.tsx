import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ArtifactFile } from '../../lib/api';
import { Toaster } from '../../components/ui/sonner';
import { detail, draw, have, index, reset, serve, status, task, type Asked } from '../../testing/serve';
import { FileView } from '../File';

const file: ArtifactFile = { path: 'notes.md', sha: 'm1', size: 16, added: 1, changed: 1, commit: 'c1' };
const saves = (asked: readonly Asked[]): unknown[] => asked.filter((a) => a.method === 'POST' && a.path === '/api/artifact/edit').map((a) => (a.body as { text: string }).text);

/** The file open in Source, its text loaded. */
async function inSource(answer: Response) {
  const asked = serve({ '/blob/m1': new Response('# Notes\n\nfirst\n'), 'POST /api/artifact/edit': answer });
  have(index([task('t1', 'notes')]), [detail('t1')]);
  const screen = await draw(
    <>
      <FileView task="t1" file={file} prev={null} next={null} pos={1} total={1} folderFiles={[file]} fileHref={(p) => `#${p}`} />
      <Toaster />
    </>,
  );
  await screen.getByText('Source').click();
  const area = screen.getByRole('textbox', { name: /notes\.md/ });
  await expect.element(area).toHaveValue('# Notes\n\nfirst\n');
  return { asked, screen, area };
}

const ok = (): Response => Response.json({ ok: true, warning: null, status: status() });

describe("a Markdown file's source, left", () => {
  afterEach(reset);

  it('with Escape, is saved and shown rendered at once, as it was saved', async () => {
    const { asked, screen, area } = await inSource(ok());
    await area.click();
    await userEvent.keyboard('{Control>}{End}{/Control}and second{Escape}');
    await expect.poll(() => saves(asked)).toEqual(['# Notes\n\nfirst\nand second']);
    await expect.element(area).not.toBeInTheDocument();
    await expect.element(screen.getByText('first and second')).toBeVisible();
  });

  it('with Escape and nothing typed, goes straight back, saving nothing', async () => {
    const { asked, screen, area } = await inSource(ok());
    await area.click();
    await userEvent.keyboard('{Escape}');
    await expect.element(area).not.toBeInTheDocument();
    await expect.element(screen.getByRole('heading', { name: 'Notes' })).toBeVisible();
    expect(saves(asked)).toEqual([]);
  });

  it('with Save, is saved and shown rendered too', async () => {
    const { asked, screen, area } = await inSource(ok());
    await area.fill('# Notes\n\nrewritten\n');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.poll(() => saves(asked)).toEqual(['# Notes\n\nrewritten\n']);
    await expect.element(screen.getByText('rewritten')).toBeVisible();
    await expect.element(area).not.toBeInTheDocument();
  });

  it('stays, with what was typed, when the save is refused', async () => {
    const { screen, area } = await inSource(new Response('notes.md changed since this page loaded it', { status: 409 }));
    await area.fill('mine');
    await area.click();
    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByText(/changed since this page loaded it/)).toBeVisible();
    await expect.element(area).toHaveValue('mine');
  });
});
