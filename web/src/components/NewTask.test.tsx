import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { draw, have, index, reset, serve } from '../testing/serve';
import { useUI } from '../state/ui';
import { NewTaskModal } from './NewTask';

const repos = [{ name: 'api', packages: [] }, { name: 'web', packages: ['app', 'admin', 'shared'] }];

describe('a new task from the page', () => {
  beforeEach(() => {
    have(index([]));
    useUI.setState({ newTask: true });
  });
  afterEach(reset);

  it('asks its title, then its repositories, then the packages of one that has them, and starts it', async () => {
    const asked = serve({ '/api/launch/repos': Response.json(repos), 'POST /api/launch': Response.json({ launch: 'L1' }) });
    const screen = await draw(<NewTaskModal />);
    await screen.getByRole('textbox', { name: 'Title' }).fill('pay retries');
    await userEvent.keyboard('{Enter}');
    // The repositories' list opens as its step comes; what is typed narrows it, and Enter picks.
    await expect.element(screen.getByRole('listbox', { name: 'Repositories' })).toBeVisible();
    await userEvent.keyboard('web{Enter}');
    await userEvent.keyboard('api{Enter}');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('listbox', { name: 'Packages of web' })).toBeVisible();
    await userEvent.keyboard('adm{Enter}');
    await userEvent.keyboard('{Enter}');
    await expect.poll(() => location.hash).toBe('#/new/L1');
    const launch = asked.find((a) => a.method === 'POST' && a.path === '/api/launch');
    // In the list's order, as bare yan's own list gives it: the first is where the agent starts.
    expect(launch?.body).toEqual({ title: 'pay retries', repos: [{ name: 'api', scope: [] }, { name: 'web', scope: ['admin'] }] });
    expect(useUI.getState().newTask).toBe(false);
    expect(useUI.getState().launched.L1?.title).toBe('pay retries');
  });

  it('takes a monorepo with every package picked, or none, as the whole of it', async () => {
    const asked = serve({ '/api/launch/repos': Response.json(repos), 'POST /api/launch': Response.json({ launch: 'L2' }) });
    const screen = await draw(<NewTaskModal />);
    await screen.getByRole('textbox', { name: 'Title' }).fill('a whole repo');
    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('web{Enter}{Enter}');
    await expect.element(screen.getByRole('listbox', { name: 'Packages of web' })).toBeVisible();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await expect.poll(() => location.hash).toBe('#/new/L2');
    expect(asked.find((a) => a.method === 'POST')?.body).toEqual({ title: 'a whole repo', repos: [{ name: 'web', scope: [] }] });
  });

  it('starts at once from any step with the modifier and Enter, and waits for a title', async () => {
    const asked = serve({ '/api/launch/repos': Response.json(repos), 'POST /api/launch': Response.json({ launch: 'L3' }) });
    const screen = await draw(<NewTaskModal />);
    await screen.getByRole('textbox', { name: 'Title' }).click();
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    expect(asked.filter((a) => a.method === 'POST')).toEqual([]);
    await userEvent.keyboard('quick');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await expect.poll(() => location.hash).toBe('#/new/L3');
    expect(asked.find((a) => a.method === 'POST')?.body).toEqual({ title: 'quick', repos: [] });
  });

  it('says in the box why serve could not start it, and keeps what was asked', async () => {
    serve({ '/api/launch/repos': Response.json([]), 'POST /api/launch': new Response('herdr is not running', { status: 409 }) });
    const screen = await draw(<NewTaskModal />);
    await screen.getByRole('textbox', { name: 'Title' }).fill('no herdr');
    await userEvent.keyboard('{Enter}');
    await expect.element(screen.getByRole('alert')).toHaveTextContent('herdr is not running');
    await expect.element(screen.getByRole('textbox', { name: 'Title' })).toHaveValue('no herdr');
    expect(useUI.getState().newTask).toBe(true);
  });

  it('keeps the keyboard in the box, and Escape closes it', async () => {
    serve({ '/api/launch/repos': Response.json(repos) });
    const screen = await draw(<NewTaskModal />);
    const dialog = screen.getByRole('dialog', { name: 'New task' });
    await screen.getByRole('textbox', { name: 'Title' }).fill('x');
    for (let i = 0; i < 4; i++) {
      await userEvent.keyboard('{Tab}');
      expect(dialog.element().contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard('{Escape}');
    await expect.poll(() => useUI.getState().newTask).toBe(false);
  });
});
