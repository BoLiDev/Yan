import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { toast } from 'sonner';
import { draw, reset } from '../testing/serve';
import { followTheme } from '../state/theme';
import { useUI } from '../state/ui';
import { Toaster } from './ui/sonner';

describe('a toast', () => {
  beforeAll(() => {
    followTheme();
    useUI.setState((s) => ({ prefs: { ...s.prefs, theme: 'dark' } }));
  });
  afterAll(() => useUI.setState((s) => ({ prefs: { ...s.prefs, theme: 'system' } })));
  afterEach(reset);

  it('stands off a dark page, white with its button black, and is closed by hand', async () => {
    const screen = await draw(<Toaster />);
    toast('pay retries', { description: 'Its agent has finished.', action: { label: 'Open terminal', onClick: () => undefined }, duration: 60_000 });
    const button = screen.getByRole('button', { name: 'Open terminal' });
    await expect.element(button).toBeVisible();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    const shown = button.element().closest('[data-sonner-toast]') as HTMLElement;
    expect(getComputedStyle(shown).backgroundColor).toBe('rgb(255, 255, 255)');
    expect(getComputedStyle(button.element()).backgroundColor).toBe('rgb(27, 27, 25)');

    await screen.getByRole('button', { name: 'Close toast' }).click();
    await expect.element(screen.getByText('pay retries')).not.toBeInTheDocument();
  });
});
