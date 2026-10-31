import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { draw, have, index, reset, serve, task } from '../testing/serve';
import { followTheme } from '../state/theme';
import { useUI } from '../state/ui';
import { Left } from './Left';

describe('the theme the page is drawn in', () => {
  beforeAll(followTheme);
  afterEach(async () => {
    useUI.setState((s) => ({ prefs: { ...s.prefs, theme: 'system' } }));
    await reset();
  });

  it('is dark or light as picked from the task list, whatever the browser asks, and kept in this browser', async () => {
    serve({});
    have(index([task('t1', 'pay retries')]));
    const screen = await draw(<Left />);
    const root = document.documentElement;

    await screen.getByRole('button', { name: 'Theme' }).click();
    await screen.getByRole('menuitemradio', { name: 'Dark' }).click();
    expect(root.classList.contains('dark')).toBe(true);
    expect(getComputedStyle(root).colorScheme).toBe('dark');
    expect(JSON.parse(localStorage.getItem('yan.serve.prefs') ?? '{}').theme).toBe('dark');
    await expect.element(screen.getByRole('menu')).not.toBeInTheDocument();

    await screen.getByRole('button', { name: 'Theme' }).click();
    await screen.getByRole('menuitemradio', { name: 'Light' }).click();
    expect(root.classList.contains('dark')).toBe(false);
    expect(getComputedStyle(root).colorScheme).toBe('light');
  });
});
