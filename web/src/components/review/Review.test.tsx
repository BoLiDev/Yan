import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { ArtifactFile } from '../../lib/api';
import { useReview } from '../../state/review';
import { Messages } from '../page';
import { Toaster } from '../ui/sonner';
import { detail, draw, have, index, reset, serve, status, task, type Asked } from '../../testing/serve';
import { FileView } from '../../views/File';
import { CommentBox } from './CommentBox';
import { ReviewPanel } from './ReviewPanel';

const file: ArtifactFile = { path: 'docs/notes.md', sha: 'r1', size: 40, added: 1, changed: 1, commit: 'c1' };
const TEXT = '# Notes\n\nRetries are unbounded for now.\n\nThe cache is never cleared.\n';
const posts = (asked: readonly Asked[], path: string): unknown[] => asked.filter((a) => a.method === 'POST' && a.path === path).map((a) => a.body);
const saved = (more: object = {}): Response => Response.json({ ok: true, warning: null, status: status(), name: 'r.md', path: 'tasks/t1/reviews/r.md', ...more });

/** Select the words `words` of the rendered file, as a drag over them does, and right click on them. */
async function pick(words: string): Promise<void> {
  const walk = document.createTreeWalker(document.querySelector('[data-slot="context-menu-trigger"]') as Element, NodeFilter.SHOW_TEXT);
  let node: Node | null = walk.nextNode();
  while (node !== null && !(node as Text).data.includes(words)) node = walk.nextNode();
  if (node === null) throw new Error(`"${words}" is not on the page`);
  const range = document.createRange();
  const at = (node as Text).data.indexOf(words);
  range.setStart(node, at);
  range.setEnd(node, at + words.length);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
  const box = range.getBoundingClientRect();
  (node.parentElement as Element).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 4, clientY: box.top + 4, button: 2 }));
}

/** The file open at its task, rendered, with the parts of the page a review is made in. */
async function reading(routes: Parameters<typeof serve>[0] = {}) {
  const asked = serve({ '/blob/r1': new Response(TEXT), ...routes });
  have(index([task('t1', 'notes')]), [detail('t1', { files: [file] })]);
  history.replaceState(null, '', '#/t/t1/a/docs/notes.md');
  const screen = await draw(
    <>
      <FileView task="t1" file={file} prev={null} next={null} pos={1} total={1} folderFiles={[file]} fileHref={(p) => `#${p}`} />
      <ReviewPanel />
      <CommentBox />
      <Messages />
      <Toaster />
    </>,
  );
  await expect.element(screen.getByText('Retries are unbounded for now.')).toBeVisible();
  return { asked, screen };
}

/** Comment `text` on `words`, from the menu a right click on them opens. */
async function commentOn(screen: Awaited<ReturnType<typeof reading>>['screen'], words: string, text: string): Promise<void> {
  await pick(words);
  await screen.getByRole('menuitem', { name: 'Comment' }).click();
  await screen.getByRole('textbox', { name: 'Comment' }).fill(text);
  await userEvent.keyboard('{Enter}');
}

describe('a review of what is read on the page', () => {
  afterEach(async () => {
    useReview.setState({ comments: {}, summary: {}, drafting: null, open: null, written: {} });
    localStorage.clear();
    await reset();
  });

  it('gathers a comment on each passage selected, and is written whole, where each is, once finished', async () => {
    const { asked, screen } = await reading({ 'POST /api/review': saved() });
    await commentOn(screen, 'unbounded', 'Cap them at five.');
    await commentOn(screen, 'never cleared', 'When should it be?');
    expect(posts(asked, '/api/review'), 'nothing sent while it is gathered').toEqual([]);

    await screen.getByRole('button', { name: /Review · 2 comments/ }).click();
    await expect.element(screen.getByRole('textbox', { name: 'Comment 1' })).toHaveValue('Cap them at five.');
    await screen.getByRole('textbox', { name: 'Comment 2' }).fill('When is it cleared?');
    await screen.getByRole('textbox', { name: 'Overall' }).fill('Two things.');
    await screen.getByRole('button', { name: 'Finish' }).click();

    await expect.poll(() => posts(asked, '/api/review')).toEqual([{
      task: 't1',
      summary: 'Two things.',
      comments: [
        { where: 'artifacts/docs/notes.md, line 3', quote: 'unbounded', text: 'Cap them at five.' },
        { where: 'artifacts/docs/notes.md, line 5', quote: 'never cleared', text: 'When is it cleared?' },
      ],
    }]);
    await expect.element(screen.getByText('tasks/t1/reviews/r.md')).toBeVisible();
    expect(posts(asked, '/api/task/review'), 'no agent asked').toEqual([]);
    expect(useReview.getState().comments.t1, 'let go of once the vault has it').toBeUndefined();
  });

  it('keeps what is gathered across a reload, and drops a comment deleted', async () => {
    const first = await reading();
    await commentOn(first.screen, 'unbounded', 'Cap them at five.');
    await commentOn(first.screen, 'never cleared', 'Never?');
    expect(JSON.parse(localStorage.getItem('yan.serve.review') ?? '{}').comments.t1).toHaveLength(2);
    await first.screen.getByRole('button', { name: /Review · 2 comments/ }).click();
    await first.screen.getByRole('button', { name: 'Delete comment 1' }).click();
    await expect.element(first.screen.getByRole('textbox', { name: 'Comment 1' })).toHaveValue('Never?');
    expect(JSON.parse(localStorage.getItem('yan.serve.review') ?? '{}').comments.t1).toHaveLength(1);
  });

  it('sent to the agent, is written first and the agent then asked, the page going to its terminal', async () => {
    const { asked, screen } = await reading({ 'POST /api/review': saved(), 'POST /api/task/review': Response.json({ typed: true }), '/api/terminals': Response.json({}) });
    await commentOn(screen, 'unbounded', 'Cap them at five.');
    await screen.getByRole('button', { name: /Review · 1 comment/ }).click();
    await screen.getByRole('button', { name: 'Send to agent' }).click();
    await expect.poll(() => posts(asked, '/api/task/review')).toEqual([{ task: 't1' }]);
    expect(asked.findIndex((a) => a.path === '/api/review')).toBeLessThan(asked.findIndex((a) => a.path === '/api/task/review'));
    await expect.poll(() => location.hash).toBe('#/t/t1/terminal');
  });

  it('says a push that failed, and an agent that could not be asked, the review written all the same', async () => {
    const { screen } = await reading({ 'POST /api/review': saved({ warning: 'origin is out of reach' }), 'POST /api/task/review': new Response('its agent is at work', { status: 409 }) });
    await commentOn(screen, 'unbounded', 'Cap them at five.');
    await screen.getByRole('button', { name: /Review · 1 comment/ }).click();
    await screen.getByRole('button', { name: 'Send to agent' }).click();
    await expect.element(screen.getByText(/the push failed: origin is out of reach/)).toBeVisible();
    await expect.element(screen.getByText(/its agent was not asked: its agent is at work/)).toBeVisible();
    await expect.element(screen.getByText('tasks/t1/reviews/r.md')).toBeVisible();
    // To be asked again.
    await expect.element(screen.getByRole('button', { name: 'Send to agent' })).toBeVisible();
  });

  it('copies what is selected, and opens its source with the same words selected to edit them', async () => {
    const { screen } = await reading();
    await pick('never cleared');
    await screen.getByRole('menuitem', { name: 'Edit' }).click();
    const area = screen.getByRole('textbox', { name: /docs\/notes\.md/ });
    await expect.element(area).toBeVisible();
    const el = area.element() as HTMLTextAreaElement;
    await expect.poll(() => el.value.slice(el.selectionStart, el.selectionEnd)).toBe('never cleared');
  });
});
