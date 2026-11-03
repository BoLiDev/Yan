import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { Draft } from '../../lib/api';
import { draw, have, index, reset, serve, status } from '../../testing/serve';
import { useUI } from '../../state/ui';
import { Toaster } from '../ui/sonner';
import { DraftsModal } from './DraftsModal';

const ideas: Draft = { id: '2026-11-02_213000-retry-ideas', title: 'Retry ideas', text: '# Retry ideas\n\nback off twice\n', sha: 's1', changed: 1_762_000_000, task: null };
const old: Draft = { id: '2026-09-01_080000', title: 'Old note', text: '# Old note\n\nkept with its task\n', sha: 's2', changed: 1_756_000_000, task: 't001' };
const posted = (asked: readonly { method: string; path: string; body: unknown }[]): unknown[] => asked.filter((a) => a.method === 'POST' && a.path === '/api/draft').map((a) => a.body);

describe("the drafts' box", () => {
  // The page has the vault at the version each save answers with, so a save fetches nothing else.
  beforeEach(() => have(index([])));
  afterEach(reset);

  it('shows the newest, and saves it, as it began, once it is left for another', async () => {
    const asked = serve({ '/api/drafts': Response.json([ideas, old]), 'POST /api/draft': Response.json({ ok: true, warning: null, status: status(), id: ideas.id }) });
    useUI.setState({ drafts: true });
    const screen = await draw(<DraftsModal />);
    await expect.element(screen.getByRole('document').getByText('back off twice')).toBeVisible();
    await screen.getByRole('document').getByText('back off twice').click();
    await userEvent.keyboard('{Control>}{End}{/Control} and say so');
    expect(posted(asked), 'nothing while it is written').toEqual([]);
    await screen.getByRole('button', { name: /Old note/ }).click();
    await expect.poll(() => posted(asked)).toEqual([{ id: ideas.id, sha: 's1', text: '# Retry ideas\n\nback off twice\n and say so' }]);
    await expect.element(screen.getByRole('document').getByText('kept with its task')).toBeVisible();
  });

  it('keeps what was written, being written, when serve refuses it, and says why', async () => {
    serve({ '/api/drafts': Response.json([ideas]), 'POST /api/draft': new Response('that draft changed since this page loaded it', { status: 409 }) });
    useUI.setState({ drafts: true });
    const screen = await draw(<><DraftsModal /><Toaster /></>);
    await screen.getByRole('document').getByText('back off twice').click();
    await screen.getByRole('textbox', { name: 'Draft' }).fill('mine');
    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByText(/that draft changed since this page loaded it/)).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('mine');
    expect(useUI.getState().drafts, 'the box stays open').toBe(true);
  });

  it('keeps what was written as a new draft when the one it was written in is gone, the box having been left', async () => {
    const asked = serve({ '/api/drafts': Response.json([old]), 'POST /api/draft': Response.json({ ok: true, warning: null, status: status(), id: '2026-11-03_090000-mine' }) });
    useUI.setState({ drafts: true, draftKept: { id: ideas.id, sha: 's1', text: '# mine\n\nwritten before it went' } });
    const screen = await draw(<DraftsModal />);
    await expect.element(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('# mine\n\nwritten before it went');
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => posted(asked)).toEqual([{ id: null, sha: 's1', text: '# mine\n\nwritten before it went' }]);
  });

  it('with none yet, is a new one, ready to write, sent with no id and kept only once something is in it', async () => {
    const asked = serve({ '/api/drafts': Response.json([]), 'POST /api/draft': Response.json({ ok: true, warning: null, status: status(), id: '2026-11-03_090000-pricing' }) });
    useUI.setState({ drafts: true });
    const screen = await draw(<DraftsModal />);
    const area = screen.getByRole('textbox', { name: 'Draft' });
    await expect.element(area).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(posted(asked), 'nothing written, nothing sent').toEqual([]);
    await screen.getByText('Nothing written yet. Click to write.').click();
    await userEvent.keyboard('# Pricing');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await expect.poll(() => posted(asked)).toEqual([{ id: null, sha: '', text: '# Pricing' }]);
  });
});
