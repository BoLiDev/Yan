import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ArtifactFile } from '../../lib/api';
import { draw, have, index, reset, serve, status, type Asked } from '../../testing/serve';
import { Toaster } from '../../components/ui/sonner';
import { MarkdownSource } from './MarkdownSource';

const file: ArtifactFile = { path: 'docs/notes.md', sha: 'n1', size: 18, added: 1, changed: 1, commit: 'c1' };
const saves = (asked: readonly Asked[]): unknown[] => asked.filter((a) => a.method === 'POST' && a.path === '/api/artifact/edit').map((a) => a.body);

describe("a Markdown artifact's source", () => {
  beforeEach(() => have(index([])));
  afterEach(reset);

  it('is written in where it is shown, and saved with ⌘S as it began, what was saved shown at once', async () => {
    const asked = serve({ '/blob/n1': new Response('# Notes\n\nfirst\n'), 'POST /api/artifact/edit': Response.json({ ok: true, warning: null, status: status() }) });
    const screen = await draw(<MarkdownSource task="t1" file={file} onMeta={() => undefined} />);
    const area = screen.getByRole('textbox', { name: /docs\/notes\.md/ });
    await expect.element(area).toHaveValue('# Notes\n\nfirst\n');
    expect(screen.getByRole('button', { name: 'Save' }).query(), 'nothing to save yet').toBeNull();
    await area.click();
    await userEvent.keyboard('{Control>}{End}{/Control}and second');
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
    await userEvent.keyboard('{Control>}s{/Control}');
    await expect.poll(() => saves(asked)).toEqual([{ task: 't1', path: 'docs/notes.md', sha: 'n1', text: '# Notes\n\nfirst\nand second' }]);
    await expect.element(screen.getByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    await expect.element(area).toHaveValue('# Notes\n\nfirst\nand second');
  });

  it('keeps what was typed when the file changed since, and says why', async () => {
    serve({ '/blob/n1': new Response('# Notes\n'), 'POST /api/artifact/edit': new Response('docs/notes.md changed since this page loaded it', { status: 409 }) });
    const screen = await draw(<><MarkdownSource task="t1" file={file} onMeta={() => undefined} /><Toaster /></>);
    const area = screen.getByRole('textbox', { name: /docs\/notes\.md/ });
    await area.fill('mine');
    await screen.getByRole('button', { name: 'Save' }).click();
    await expect.element(screen.getByText(/changed since this page loaded it/)).toBeVisible();
    await expect.element(area).toHaveValue('mine');
    await expect.element(screen.getByRole('button', { name: 'Save' })).toBeVisible();
  });

  it('puts the file back as it was when what was typed is discarded', async () => {
    const asked = serve({ '/blob/n1': new Response('# Notes\n') });
    const screen = await draw(<MarkdownSource task="t1" file={file} onMeta={() => undefined} />);
    const area = screen.getByRole('textbox', { name: /docs\/notes\.md/ });
    await area.fill('scratch');
    await screen.getByRole('button', { name: 'Discard' }).click();
    await expect.element(area).toHaveValue('# Notes\n');
    expect(saves(asked)).toEqual([]);
  });
});
