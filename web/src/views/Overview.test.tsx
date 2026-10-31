import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { TaskDetail } from '../lib/api';
import { detail, draw, have, index, reset, serve, status, task } from '../testing/serve';
import { useUI } from '../state/ui';
import { Toaster } from '../components/ui/sonner';
import { Overview } from './Overview';

const t = task('t1', 'pay retries');
const d: TaskDetail = detail('t1', {
  problem: { path: 'tasks/t1/problem.md', sha: 'p1', text: '# pay retries\n\nRetries are not paid.\n', changed: 0 },
  deliverables: [{ id: 'd1', text: 'retries are paid', status: 'todo', doneAt: null, reason: null }],
});

describe("a task's overview", () => {
  beforeEach(() => have(index([t]), [d]));
  afterEach(reset);

  it('edits problem.md whole and saves it against the file it began from', async () => {
    const asked = serve({ 'POST /api/problem': Response.json({ ok: true, warning: null, status: status() }) });
    const screen = await draw(<Overview t={t} d={d} />);
    await screen.getByRole('button', { name: /Edit/ }).click();
    const area = screen.getByRole('textbox', { name: 'problem.md' });
    await expect.element(area).toHaveValue(d.problem?.text);
    await area.fill('# pay retries\n\nRetries are paid twice.');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await expect.poll(() => asked.find((a) => a.path === '/api/problem')?.body).toEqual({ task: 't1', sha: 'p1', text: '# pay retries\n\nRetries are paid twice.' });
    await expect.element(screen.getByRole('textbox', { name: 'problem.md' })).not.toBeInTheDocument();
  });

  it('keeps what was typed when an agent changed the file meanwhile, and says so', async () => {
    serve({ 'POST /api/problem': new Response('problem.md changed since this page loaded it', { status: 409 }) });
    const screen = await draw(<><Overview t={t} d={d} /><Toaster /></>);
    await screen.getByRole('button', { name: /Edit/ }).click();
    await screen.getByRole('textbox', { name: 'problem.md' }).fill('mine');
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
    await expect.element(screen.getByText(/problem\.md changed since this page loaded it/)).toBeVisible();
    await expect.element(screen.getByRole('textbox', { name: 'problem.md' })).toHaveValue('mine');
  });

  it('does not let Escape throw away an edit', async () => {
    serve({});
    const screen = await draw(<Overview t={t} d={d} />);
    await screen.getByRole('button', { name: /Edit/ }).click();
    await screen.getByRole('textbox', { name: 'problem.md' }).fill('half written');
    await userEvent.keyboard('{Escape}');
    await expect.element(screen.getByRole('textbox', { name: 'problem.md' })).toHaveValue('half written');
  });

  it('asks before deleting a deliverable, and deletes it once asked', async () => {
    const asked = serve({ 'POST /api/deliverable/remove': Response.json({ ok: true, warning: null, status: status() }) });
    const screen = await draw(<Overview t={t} d={d} />);
    await screen.getByRole('button', { name: 'Delete d1' }).click();
    expect(asked.filter((a) => a.method === 'POST')).toEqual([]);
    expect(useUI.getState().ask?.title).toMatch(/d1/);
    useUI.getState().ask?.then('');
    await expect.poll(() => asked.find((a) => a.method === 'POST')?.body).toEqual({ task: 't1', id: 'd1' });
  });
});
