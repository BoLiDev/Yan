import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { Draft } from '../../lib/api';
import { draw, have, index, reset, serve, type Asked } from '../../testing/serve';
import { useUI } from '../../state/ui';
import { Toaster } from '../ui/sonner';
import { DraftsModal } from './DraftsModal';

const ideas: Draft = { id: '2026-11-02_213000-retry-ideas', title: 'Retry ideas', text: '# Retry ideas\n\nback off twice\n', sha: 's1', begun: 1_762_000_000, task: null };
const old: Draft = { id: '2026-09-01_080000', title: 'Old note', text: '# Old note\n\nkept with its task\n', sha: 's2', begun: 1_756_000_000, task: 't001' };
const writes = (asked: readonly Asked[], path = '/api/draft'): unknown[] => asked.filter((a) => a.method === 'POST' && a.path === path).map((a) => a.body);
/** serve writing a draft as asked: done, under the id it was given or a new one, its fingerprint the text's length. */
const written = (made = '2026-11-03_090000-new') => ({ body }: Asked): Response => {
  const { id, text } = body as { id: string | null; text: string };
  return Response.json({ draft: { id: id ?? made, title: text.split('\n')[0]?.replace(/^#+\s*/, '') ?? '', text, sha: `w${text.length}`, begun: 1_763_000_000, task: null } });
};

describe("the drafts' box", () => {
  // The page has the vault at the version each save answers with, so a save fetches nothing else.
  beforeEach(() => have(index([])));
  afterEach(reset);

  it('opens on the newest, written at once where it is clicked, and what is typed written as the typing pauses, each write naming the last', async () => {
    const asked = serve({ '/api/drafts': Response.json([ideas, old]), 'POST /api/draft': written() });
    useUI.setState({ drafts: true });
    const screen = await draw(<DraftsModal />);
    await screen.getByRole('document').getByText('back off twice').click();
    const area = screen.getByRole('textbox', { name: 'Draft' });
    await expect.element(area).toHaveFocus();
    await userEvent.keyboard('{Control>}{End}{/Control} and say so');
    await expect.poll(() => writes(asked)).toEqual([{ id: ideas.id, sha: 's1', text: '# Retry ideas\n\nback off twice\n and say so' }]);
    await userEvent.keyboard('!');
    await expect.poll(() => writes(asked)).toHaveLength(2);
    expect(writes(asked)[1], 'the second names the draft as the first left it').toEqual({ id: ideas.id, sha: 'w41', text: '# Retry ideas\n\nback off twice\n and say so!' });
  });

  it('asks which to keep when the draft changed elsewhere meanwhile, and keeps both as two drafts when asked to', async () => {
    const theirs: Draft = { ...ideas, text: '# Retry ideas\n\nback off three times\n', sha: 's9' };
    const asked = serve({
      '/api/drafts': Response.json([ideas]),
      'POST /api/draft': (a) => ((a.body as { id: string | null }).id === null ? written()(a) : Response.json({ error: 'that draft changed since this page read it', theirs }, { status: 409 })),
    });
    useUI.setState({ drafts: true });
    const screen = await draw(<DraftsModal />);
    await screen.getByRole('document').getByText('back off twice').click();
    await screen.getByRole('textbox', { name: 'Draft' }).fill('mine');
    const clash = screen.getByRole('alert');
    await expect.element(clash).toMatchTextContent(/changed elsewhere/);
    // What was written stays.
    await expect.element(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('mine');
    await clash.getByRole('button', { name: 'Keep both' }).click();
    await expect.poll(() => writes(asked).at(-1)).toEqual({ id: null, sha: '', text: 'mine' });
    await expect.element(screen.getByRole('alert')).not.toBeInTheDocument();
  });

  it('deletes a draft from its menu in the list once asked, gone at once, and put back with why when serve refuses', async () => {
    const asked = serve({ '/api/drafts': Response.json([ideas, old]), 'POST /api/draft/delete': new Response('the vault cannot be written', { status: 500 }) });
    useUI.setState({ drafts: true });
    const screen = await draw(<><DraftsModal /><Toaster /></>);
    const row = screen.getByRole('button', { name: /Old note/ });
    await row.click({ button: 'right' });
    await screen.getByRole('menuitem', { name: 'Delete' }).click();
    expect(writes(asked, '/api/draft/delete'), 'not before it is answered').toEqual([]);
    await screen.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    expect(writes(asked, '/api/draft/delete')).toEqual([{ id: old.id, sha: 's2' }]);
    await expect.element(screen.getByText(/the vault cannot be written/)).toBeVisible();
    // Back once refused.
    await expect.element(screen.getByRole('button', { name: /Old note/ })).toBeVisible();
  });

  it('asks to delete a draft left blank, and keeps it as it was when that is cancelled', async () => {
    const asked = serve({ '/api/drafts': Response.json([ideas]), 'POST /api/draft': written() });
    useUI.setState({ drafts: true });
    const screen = await draw(<DraftsModal />);
    await screen.getByRole('document').getByText('back off twice').click();
    await screen.getByRole('textbox', { name: 'Draft' }).fill('');
    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByRole('alertdialog')).toMatchTextContent(/Delete “Retry ideas”\?/);
    await screen.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
    await expect.element(screen.getByRole('document').getByText('back off twice')).toBeVisible();
    expect(writes(asked), 'nothing blank written').toEqual([]);
  });

  it('with none yet, is a new one, ready to write, kept only once something is in it, and written on under its new id', async () => {
    const asked = serve({ '/api/drafts': Response.json([]), 'POST /api/draft': written('2026-11-03_090000-pricing') });
    useUI.setState({ drafts: true });
    const screen = await draw(<DraftsModal />);
    const area = screen.getByRole('textbox', { name: 'Draft' });
    await expect.element(area).toHaveFocus();
    await userEvent.keyboard('# Pricing');
    await expect.poll(() => writes(asked)).toEqual([{ id: null, sha: '', text: '# Pricing' }]);
    await expect.element(screen.getByRole('button', { name: /Pricing/ })).toBeVisible();
    // The same page, still being written.
    await expect.element(area).toHaveFocus();
    await userEvent.keyboard(' tiers');
    await expect.poll(() => writes(asked).at(-1)).toEqual({ id: '2026-11-03_090000-pricing', sha: 'w9', text: '# Pricing tiers' });
  });
});
