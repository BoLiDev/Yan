import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { draw, have, index, reset, serve, status, task } from '../testing/serve';
import { followTheme } from '../state/theme';
import { useUI } from '../state/ui';
import { SettingsModal } from '../components/Settings';
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

  it('says when one will never go through by itself, conflicting with origin', async () => {
    serve({});
    have({ ...index([task('t1', 'pay retries')]), status: { ...status(), push: { pending: true, error: 'rebasing onto origin/main conflicts - open /v and sort it out' } } });
    const screen = await draw(<Left />);
    await expect.element(screen.getByText(/conflicts with origin/)).toBeVisible();
  });
});

describe('what this browser is set to', () => {
  beforeAll(followTheme);
  afterEach(async () => {
    useUI.setState((s) => ({ prefs: { ...s.prefs, theme: 'system', badges: true } }));
    await reset();
  });

  /** The task list with a task that has something new, and the settings' box beside it. */
  async function withNews() {
    serve({ '/api/yan/update': Response.json({ running: false, steps: [], error: null }) });
    const ix = index([task('t1', 'pay retries'), task('t2', 'export orders')], { latest: [{ task: 't1', at: 50, files: [{ path: 'notes.md', sha: 'n1', status: 'A', at: 50 }] }] });
    have(ix);
    useUI.setState({ seen: { init: 10, tasks: {}, problems: {}, logs: {}, files: {}, agents: {} } });
    history.replaceState(null, '', '#/t/t2');
    return draw(<><Left /><SettingsModal /></>);
  }

  it('is one box away from the task list: the theme, dark or light whatever the browser asks, kept in this browser', async () => {
    const screen = await withNews();
    const root = document.documentElement;
    await screen.getByRole('button', { name: 'Settings' }).click();
    await screen.getByRole('dialog').getByRole('button', { name: 'Dark' }).click();
    expect(root.classList.contains('dark')).toBe(true);
    expect(getComputedStyle(root).colorScheme).toBe('dark');
    expect(JSON.parse(localStorage.getItem('yan.serve.prefs') ?? '{}').theme).toBe('dark');
    await screen.getByRole('dialog').getByRole('button', { name: 'Light' }).click();
    expect(root.classList.contains('dark')).toBe(false);
    expect(getComputedStyle(root).colorScheme).toBe('light');
    await expect.element(screen.getByRole('dialog').getByRole('button', { name: 'Check for updates' })).toBeVisible();
  });

  it('marks what is new beside its task, or does not, as the marks are turned on or off', async () => {
    const screen = await withNews();
    // By its title: the task list is out of reach of a role while the settings' box is over it.
    await expect.element(screen.getByTitle('1 added')).toBeVisible();
    await screen.getByRole('button', { name: 'Settings' }).click();
    await screen.getByRole('switch', { name: 'Marks on what is new' }).click();
    await expect.element(screen.getByTitle('1 added')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('yan.serve.prefs') ?? '{}').badges).toBe(false);
    await screen.getByRole('switch', { name: 'Marks on what is new' }).click();
    // What was not looked at meanwhile is still new.
    await expect.element(screen.getByTitle('1 added')).toBeVisible();
  });
});
