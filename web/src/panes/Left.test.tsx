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

  it('keeps a vault in step with its remote, or local with the switch off, and a vault with no remote cannot be turned on', async () => {
    const one = { name: 'fixture', dir: '/vault', local: false, origin: true, ok: true, fileLink: null };
    const asked = serve({ '/api/yan/update': Response.json({ running: false, steps: [], error: null }), '/api/vault/local': Response.json({ ...status(2), local: true, vaults: [{ ...one, local: true }] }) });
    have({ ...index([task('t1', 'pay retries')]), status: { ...status(), vaults: [one] } });
    const screen = await draw(<><Left /><SettingsModal /></>);
    await expect.element(screen.getByText('Synced')).toBeVisible();
    await screen.getByRole('button', { name: 'Settings' }).click();
    const sync = screen.getByRole('switch', { name: 'Sync fixture with its remote' });
    await expect.element(sync).toBeChecked();
    await sync.click();
    await expect.element(sync).not.toBeChecked();
    expect(asked.find((a) => a.path === '/api/vault/local')?.body).toEqual({ local: true });
    await expect.element(screen.getByText('kept on this machine alone')).toBeInTheDocument();

    useUI.setState({ status: { ...status(3), local: true, origin: false, vaults: [{ ...one, local: true, origin: false }] } });
    await expect.element(sync).not.toBeChecked();
    await expect.element(sync).toBeDisabled();
  });

  it('switches each of several vaults by itself', async () => {
    const vaults = [{ name: 'team', dir: '/team', local: false, origin: true, ok: true, fileLink: null }, { name: 'work', dir: '/work', local: true, origin: false, ok: true, fileLink: null }];
    const asked = serve({ '/api/yan/update': Response.json({ running: false, steps: [], error: null }), '/api/vault/local': Response.json({ ...status(2), vaults: [{ ...vaults[0], local: true }, vaults[1]] }) });
    have({ ...index([task('t1', 'pay retries', { vault: 'team' })]), status: { ...status(), vaults } });
    const screen = await draw(<><Left /><SettingsModal /></>);
    await screen.getByRole('button', { name: 'Settings' }).click();
    await expect.element(screen.getByRole('switch', { name: 'Sync work with its remote' })).toBeDisabled();
    await screen.getByRole('switch', { name: 'Sync team with its remote' }).click();
    await expect.element(screen.getByRole('switch', { name: 'Sync team with its remote' })).not.toBeChecked();
    expect(asked.find((a) => a.path === '/api/vault/local')?.body).toEqual({ local: true, vault: 'team' });
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
