import { afterEach, describe, expect, it } from 'vitest';
import { SettingsModal } from '../../components/Settings';
import { useUI } from '../../state/ui';
import { detail, draw, have, index, reset, serve, task } from '../../testing/serve';
import { Middle } from '../Middle';
import { Right } from '../Right';

const principles = { path: 'tasks/t1/principles.md', sha: 'p1', text: '- Never touch the public API.\n', changed: 0 };

/** A task's column and what it shows on the right, the settings' box beside them; the page at `hash`. */
async function aTask(more: Parameters<typeof detail>[1], hash = '#/t/t1') {
  serve({ '/api/terminals': Response.json({}), '/api/worktrees': Response.json({}), '/api/yan/update': Response.json({ running: false, steps: [], error: null }) });
  have(index([task('t1', 'pay retries', { state: 'done' })]), [detail('t1', more)]);
  location.hash = hash;
  const screen = await draw(<><Middle /><Right /><SettingsModal /></>);
  // Read from the page itself: under the settings' box the column is not a screen reader's to find.
  const rows = (): string[] => [...document.querySelectorAll('#middle a')].map((e) => e.textContent ?? '');
  return { screen, rows };
}

describe("a task's column", () => {
  afterEach(reset);

  it('has a Principles row, after Overview, only for a task the user recorded some for, which shows them', async () => {
    const none = await aTask({});
    await expect.poll(none.rows).toEqual(['Overview', 'Log']);
    await reset();

    const { screen, rows } = await aTask({ principles });
    await expect.poll(rows).toEqual(['Overview', 'Principles', 'Log']);
    await screen.getByRole('link', { name: 'Principles' }).click();
    expect(location.hash).toBe('#/t/t1/principles');
    await expect.element(screen.getByText('Never touch the public API.')).toBeVisible();
  });

  it('leaves out the rows turned off in the settings, kept in this browser, but the one being shown', async () => {
    const { screen, rows } = await aTask({ principles });
    await expect.poll(rows).toEqual(['Overview', 'Principles', 'Log']);
    useUI.setState({ settings: true });
    await screen.getByRole('group', { name: "A task's pages" }).getByRole('button', { name: 'Log' }).click();
    await expect.poll(rows).toEqual(['Overview', 'Principles']);
    expect(JSON.parse(localStorage.getItem('yan.serve.prefs') ?? '{}').hiddenPages).toEqual(['log']);

    // Gone to by its address, a page left out is on the nav while it is shown.
    location.hash = '#/t/t1/log';
    await expect.poll(rows).toEqual(['Overview', 'Principles', 'Log']);
    await screen.getByRole('group', { name: "A task's pages" }).getByRole('button', { name: 'Log' }).click();
    location.hash = '#/t/t1';
    await expect.poll(rows).toEqual(['Overview', 'Principles', 'Log']);
  });
});
