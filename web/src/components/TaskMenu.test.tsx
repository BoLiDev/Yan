import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { TerminalState, WriteResult } from '../lib/api';
import { draw, have, index, reset, serve, status, task, type Asked } from '../testing/serve';
import { Left } from '../panes/Left';
import { Rail } from '../panes/Rail';
import { TaskActModal } from './TaskMenu';

// The vault as the page has it, so nothing is fetched again after the save.
const saved: WriteResult = { ok: true, warning: null, status: status() };
const running: TerminalState = { status: 'idle', agent: 'claude', cli: 'claude', pane: 'w1:p2', since: '2026-11-01T09:00:00Z', herdr: '0.9.5', streams: true, layout: { pane: 'w1:p2' } };
const posted = (asked: readonly Asked[], path: string): unknown[] => asked.filter((a) => a.method === 'POST' && a.path === path).map((a) => a.body);

/** The task list with the box its menu opens, over a vault of an open task and a closed one. */
async function aList(routes: Parameters<typeof serve>[0] = {}) {
  const asked = serve(routes);
  have(index([task('t1', 'pay retries'), task('t2', 'old work', { state: 'done', closedAt: '2026-10-02T10:00:00Z' })]));
  const screen = await draw(<><Left /><TaskActModal /></>);
  return { asked, screen };
}

describe("a task's menu in the task list", () => {
  afterEach(reset);

  it('opens on a right click in place of the browser\'s, renaming any task and closing only an open one', async () => {
    const { screen } = await aList();
    await screen.getByRole('link', { name: /pay retries/ }).click({ button: 'right' });
    const menu = screen.getByRole('menu');
    await expect.element(menu.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    await expect.element(menu.getByRole('menuitem', { name: 'Done' })).toBeVisible();
    await expect.element(menu.getByRole('menuitem', { name: 'Abandon' })).toBeVisible();
    await userEvent.keyboard('{Escape}');

    await screen.getByRole('button', { name: /October/ }).click();
    await screen.getByRole('link', { name: /old work/ }).click({ button: 'right' });
    await expect.element(screen.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Done' }).query(), 'a closed task is closed already').toBeNull();
  });

  it('renames a task from a box that starts with its title, waits for serve, and says in the box why serve refused', async () => {
    let refuse = true;
    const { asked, screen } = await aList({
      'POST /api/task/title': () => (refuse ? new Response('a task needs a title, on one line', { status: 400 }) : Response.json(saved)),
    });
    await screen.getByRole('link', { name: /pay retries/ }).click({ button: 'right' });
    await screen.getByRole('menuitem', { name: 'Rename' }).click();
    const box = screen.getByRole('alertdialog');
    const title = box.getByRole('textbox', { name: 'Title' });
    await expect.element(title).toHaveValue('pay retries');
    // Nothing to rename to yet.
    await expect.element(box.getByRole('button', { name: 'Rename' })).toBeDisabled();

    await title.fill('payment retries, again');
    await userEvent.keyboard('{Enter}');
    await expect.element(box.getByRole('alert')).toHaveTextContent('a task needs a title, on one line');
    // Still open, to try again.
    await expect.element(box).toBeVisible();

    refuse = false;
    await box.getByRole('button', { name: 'Rename' }).click();
    await expect.element(screen.getByRole('alertdialog')).not.toBeInTheDocument();
    expect(posted(asked, '/api/task/title')).toEqual([{ task: 't1', title: 'payment retries, again' }, { task: 't1', title: 'payment retries, again' }]);
  });

  it('has the agent close a task as done, its button waiting for serve, then goes to its terminal', async () => {
    let answer: (r: Response) => void = () => undefined;
    const { asked, screen } = await aList({
      '/api/terminals': Response.json({ t1: running }),
      'POST /api/task/close': () => new Promise<Response>((resolve) => (answer = resolve)),
    });
    await screen.getByRole('link', { name: /pay retries/ }).click({ button: 'right' });
    await screen.getByRole('menuitem', { name: 'Done' }).click();
    const box = screen.getByRole('alertdialog');
    await box.getByRole('button', { name: 'Ask the agent' }).click();

    await expect.element(box.getByRole('button', { name: 'Ask the agent' })).toHaveAttribute('aria-busy', 'true');
    await expect.element(box.getByRole('button', { name: 'Ask the agent' })).toBeDisabled();
    await userEvent.keyboard('{Escape}');
    // Kept open while serve is asked.
    await expect.element(box).toBeVisible();

    answer(Response.json({ typed: true }));
    await expect.poll(() => location.hash).toBe('#/t/t1/terminal');
    await expect.element(screen.getByRole('alertdialog')).not.toBeInTheDocument();
    expect(posted(asked, '/api/task/close')).toEqual([{ task: 't1' }]);
  });

  it('gives a task up only with a reason, and says when its agent has to be answered first, with the way to its terminal', async () => {
    const { asked, screen } = await aList({
      '/api/terminals': Response.json({ t1: { ...running, status: 'blocked' } }),
      'POST /api/task/close': new Response('its agent is waiting on you: answer it in its terminal first', { status: 409 }),
    });
    await screen.getByRole('link', { name: /pay retries/ }).click({ button: 'right' });
    await screen.getByRole('menuitem', { name: 'Abandon' }).click();
    const box = screen.getByRole('alertdialog');
    await expect.element(box.getByRole('button', { name: 'Give up' })).toBeDisabled();
    await box.getByRole('textbox', { name: 'Why it is given up' }).fill('  the API was dropped ');
    await userEvent.keyboard('{Enter}');

    // serve's own words.
    await expect.element(box.getByRole('alert')).toMatchTextContent(/its agent is waiting on you/);
    expect(posted(asked, '/api/task/close')).toEqual([{ task: 't1', abandon: 'the API was dropped' }]);
    await box.getByRole('link', { name: 'Go to its terminal' }).click();
    await expect.poll(() => location.hash).toBe('#/t/t1/terminal');
    await expect.element(screen.getByRole('alertdialog')).not.toBeInTheDocument();
  });
});

describe("a task's menu on the rail", () => {
  afterEach(reset);

  it('opens on its square as on its row', async () => {
    serve({});
    have(index([task('t1', 'pay retries')]));
    const screen = await draw(<><Rail /><TaskActModal /></>);
    await screen.getByRole('link', { name: 'pay retries' }).click({ button: 'right' });
    await screen.getByRole('menuitem', { name: 'Rename' }).click();
    await expect.element(screen.getByRole('alertdialog').getByRole('textbox', { name: 'Title' })).toHaveValue('pay retries');
  });
});
