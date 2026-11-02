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
  const worktree: WorktreeState = { tab: 'w1:t4', layout: { split: 'right', ratio: 0.5, first: { pane: 'w1:p5' }, second: { pane: 'w1:p6' } }, herdr: '0.7.1', streams: false };
  const posted = (asked: readonly Asked[], path: string): unknown[] => asked.filter((a) => a.method === 'POST' && a.path === path).map((a) => a.body);

  it("are Agent and, once opened, Worktree, each shown by a click and closed by its × when asked twice", async () => {
    const asked = serve({ '/api/terminals': Response.json({ t1: agent }), '/api/worktrees': Response.json({ t1: worktree }), 'POST /api/worktree/close': Response.json({ ok: true }) });
    have(index([task('t1', 'pay retries')]), [detail('t1')]);
    history.replaceState(null, '', '#/t/t1/terminal');
    const screen = await draw(<Right />);
    const tabs = screen.getByRole('tablist', { name: 'Terminal' });
    await expect.element(tabs.getByRole('tab', { name: /Worktree/ })).toBeVisible();
    await expect.element(tabs.getByRole('tab', { name: /Agent/ })).toHaveAttribute('aria-selected', 'true');

    await tabs.getByRole('tab', { name: /Worktree/ }).click();
    await expect.element(tabs.getByRole('tab', { name: /Worktree/ })).toHaveAttribute('aria-selected', 'true');
    expect(useUI.getState().termTab.t1).toBe('worktree');

    await screen.getByRole('button', { name: 'Close Worktree' }).click();
    expect(posted(asked, '/api/worktree/close'), 'not on the first click').toEqual([]);
    await screen.getByRole('button', { name: 'Really close the worktrees' }).click();
    await expect.poll(() => posted(asked, '/api/worktree/close')).toEqual([{ task: 't1' }]);
    expect(useUI.getState().termTab.t1, 'the agent shown again').toBe('agent');
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
