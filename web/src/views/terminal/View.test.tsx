import { afterEach, describe, expect, it } from 'vitest';
import type { TerminalState, WorktreeState } from '../../lib/api';
import { detail, draw, have, index, reset, serve, task, type Asked } from '../../testing/serve';
import { Right } from '../../panes/Right';
import { useUI } from '../../state/ui';

describe("a task's terminal", () => {
  afterEach(reset);

  it('gives way to the overview of a closed task once serve has no terminal for it, the closing it showed over', async () => {
    serve({ '/api/terminals': Response.json({}) });
    have(index([task('t2', 'old work', { state: 'done', closedAt: '2026-11-01T10:00:00Z' })]), [detail('t2', { state: 'done' })]);
    history.replaceState(null, '', '#/t/t2/terminal');
    await draw(<Right />);
    await expect.poll(() => location.hash).toBe('#/t/t2');
  });

  it("stays on an open task's, which Continue starts again", async () => {
    serve({ '/api/terminals': Response.json({}) });
    have(index([task('t1', 'pay retries')]), [detail('t1')]);
    history.replaceState(null, '', '#/t/t1/terminal');
    const screen = await draw(<Right />);
    await expect.element(screen.getByRole('button', { name: 'Continue' })).toBeVisible();
    expect(location.hash).toBe('#/t/t1/terminal');
  });
});

describe("a task's terminal tabs", () => {
  afterEach(reset);

  // herdr too old to stream, so each tab says so rather than drawing a pane: what is drawn of a tab is not what is asked here.
  const agent: TerminalState = { status: 'idle', agent: 'claude', cli: 'claude', pane: 'w1:p2', since: '2026-11-01T09:00:00Z', herdr: '0.7.1', streams: false, layout: { pane: 'w1:p2' } };
  const web: WorktreeState = { tab: 'w1:t4', name: 'web', layout: { pane: 'w1:p5' }, herdr: '0.7.1', streams: false };
  const api: WorktreeState = { tab: 'w1:t5', name: 'api', layout: { pane: 'w1:p6' }, herdr: '0.7.1', streams: false };
  const posted = (asked: readonly Asked[], path: string): unknown[] => asked.filter((a) => a.method === 'POST' && a.path === path).map((a) => a.body);

  it('are Agent and one for each worktree opened, named for its repository, each shown by a click and closed by its × when asked twice', async () => {
    const asked = serve({ '/api/terminals': Response.json({ t1: agent }), '/api/worktrees': Response.json({ t1: [web, api] }), 'POST /api/worktree/close': Response.json({ ok: true }) });
    have(index([task('t1', 'pay retries')]), [detail('t1')]);
    history.replaceState(null, '', '#/t/t1/terminal');
    const screen = await draw(<Right />);
    const tabs = screen.getByRole('tablist', { name: 'Terminal' });
    await expect.element(tabs.getByRole('tab', { name: /api/ })).toBeVisible();
    expect(tabs.getByRole('tab').elements().map((e) => e.textContent)).toEqual(['Agent', 'web', 'api']);
    await expect.element(tabs.getByRole('tab', { name: /Agent/ })).toHaveAttribute('aria-selected', 'true');

    await tabs.getByRole('tab', { name: /web/ }).click();
    await expect.element(tabs.getByRole('tab', { name: /web/ })).toHaveAttribute('aria-selected', 'true');

    await screen.getByRole('button', { name: 'Close web' }).click();
    expect(posted(asked, '/api/worktree/close'), 'not on the first click').toEqual([]);
    await screen.getByRole('button', { name: 'Really close web' }).click();
    await expect.poll(() => posted(asked, '/api/worktree/close')).toEqual([{ task: 't1', tab: 'w1:t4' }]);
    // Once serve has answered, not as soon as it is asked: the agent's tab is shown again after the close goes through.
    await expect.poll(() => useUI.getState().termTab.t1).toBe('agent');
  });

  it('has only Agent, with Continue and nothing to close, while no agent runs and no worktree is open', async () => {
    serve({ '/api/terminals': Response.json({}), '/api/worktrees': Response.json({}) });
    have(index([task('t1', 'pay retries')]), [detail('t1')]);
    history.replaceState(null, '', '#/t/t1/terminal');
    const screen = await draw(<Right />);
    await expect.element(screen.getByRole('button', { name: 'Continue' })).toBeVisible();
    expect(screen.getByRole('tab').elements()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Close Agent' }).query()).toBeNull();
  });
});
