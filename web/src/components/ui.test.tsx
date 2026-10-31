import { afterEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { draw, reset } from '../testing/serve';
import { ask, useUI } from '../state/ui';
import { AskModal } from './ui';

describe('a question over the page', () => {
  afterEach(reset);

  it('answers with its button, and lets go with Escape without answering', async () => {
    const then = vi.fn();
    ask({ title: 'Delete d1?', action: 'Delete', then });
    const screen = await draw(<AskModal />);
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => useUI.getState().ask).toBeNull();
    await expect.element(screen.getByRole('alertdialog')).not.toBeInTheDocument();
    expect(then).not.toHaveBeenCalled();

    ask({ title: 'Delete d1?', action: 'Delete', then });
    await screen.getByRole('button', { name: 'Delete' }).click();
    expect(then).toHaveBeenCalledWith('');
    expect(useUI.getState().ask).toBeNull();
  });

  it('asking for a reason, waits for one, then gives it with Enter', async () => {
    const then = vi.fn();
    ask({ title: 'Give up d1?', action: 'Give up', reason: 'Why', then });
    const screen = await draw(<AskModal />);
    await expect.element(screen.getByRole('button', { name: 'Give up' })).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    expect(then).not.toHaveBeenCalled();
    await screen.getByRole('textbox', { name: 'Why' }).fill('  not this round  ');
    await userEvent.keyboard('{Enter}');
    expect(then).toHaveBeenCalledWith('not this round');
  });
});
