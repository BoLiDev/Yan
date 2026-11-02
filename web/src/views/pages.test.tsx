import { afterEach, describe, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import type { WriteResult } from '../lib/api';
import { detail, draw, have, index, reset, serve, status, task, type Asked } from '../testing/serve';
import { AskModal } from '../components/page';
import { AgentView } from './Agent';
import { ResourcesView } from './Resources';

// The vault as the page has it, so nothing is fetched again after a save.
const saved: WriteResult = { ok: true, warning: null, status: status() };
const posted = (asked: readonly Asked[], path: string): unknown[] => asked.filter((a) => a.method === 'POST' && a.path === path).map((a) => a.body);

describe("a task's agents, on their page", () => {
  afterEach(reset);

  it('are dragged into another order, kept in task.json, the first the one going to the task opens', async () => {
    const asked = serve({ 'POST /api/agents': Response.json(saved) });
    const t = task('t1', 'pay retries', { agents: [['first', 'https://agents.example/1'], ['second', 'https://agents.example/2']] });
    have(index([t]));
    const screen = await draw(<AgentView t={t} />);
    // Dropped on the lower half of the card after it, where its address is.
    await userEvent.dragAndDrop(screen.getByText('first', { exact: true }), screen.getByText('https://agents.example/2'));
    await expect.poll(() => posted(asked, '/api/agents')).toEqual([{ task: 't1', order: ['second', 'first'] }]);
    // Shown in the order dropped while the vault catches up.
    const names = screen.getByRole('link').elements().map((a) => a.querySelector('b')?.textContent);
    expect(names).toEqual(['second', 'first']);
  });
});

describe("a task's resources, on their page", () => {
  afterEach(reset);

  const t = task('t1', 'pay retries');
  const d = detail('t1', {
    resources: [['WEB-1', 'https://tracker.example/WEB-1'], ['pr 42', 'https://git.example/pull/42'], ['notes', 'ask design']],
    resourceKinds: { 'WEB-1': 'spec', 'pr 42': 'mr', notes: 'general' },
  });

  it('leave the merge requests to MR, and are edited and forgotten from their cards', async () => {
    const asked = serve({ 'POST /api/resource': Response.json(saved) });
    have(index([t]), [d]);
    const screen = await draw(<><ResourcesView t={t} d={d} /><AskModal /></>);
    await expect.element(screen.getByText('https://tracker.example/WEB-1')).toBeVisible();
    expect(screen.getByText('https://git.example/pull/42').query()).toBeNull();

    await screen.getByText('ask design').hover();
    await screen.getByRole('button', { name: 'Edit notes' }).click();
    await userEvent.keyboard('{Control>}a{/Control}ask design about the banner{Enter}');
    await expect.poll(() => posted(asked, '/api/resource')).toEqual([{ task: 't1', name: 'notes', where: 'ask design about the banner' }]);

    await screen.getByText('https://tracker.example/WEB-1').hover();
    await screen.getByRole('button', { name: 'Delete WEB-1' }).click();
    await screen.getByRole('alertdialog').getByRole('button', { name: 'Delete' }).click();
    await expect.poll(() => posted(asked, '/api/resource').at(-1)).toEqual({ task: 't1', name: 'WEB-1', remove: true });
  });
});
