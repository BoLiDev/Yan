import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { draw, have, index, reset, serve, status, task } from '../testing/serve';
import { followTheme } from '../state/theme';
import { useUI } from '../state/ui';
import { Left } from './Left';

describe('the card that says how the vault stands with origin', () => {
  afterEach(reset);

  it('says a change made here that is not pushed yet, until it is', async () => {
    serve({});
    have({ ...index([task('t1', 'pay retries')]), status: { ...status(), push: { pending: true, error: 'could not reach origin' } } });
    const screen = await draw(<Left />);
    await expect.element(screen.getByText('Not pushed yet')).toBeVisible();
    useUI.setState({ status: status(2) });
    await expect.element(screen.getByText('Synced')).toBeVisible();
  });
});

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
