import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import type { Index, TerminalState } from '../lib/api';
import { Toaster } from '../components/ui/sonner';
import { AGENT_TOASTER, useAgentToasts } from '../state/agentToasts';
import { queryClient } from '../state/server';
import { useUI } from '../state/ui';
import { draw, have, index, reset, serve, status, task } from '../testing/serve';
import { Left } from './Left';

const agent = (now: TerminalState['status'], at: number, from: TerminalState['status'] = 'working'): TerminalState =>
  ({ status: now, change: { from, to: now, at }, agent: 'claude', cli: 'claude', pane: 'w1:p2', since: '2026-11-01T09:00:00Z', herdr: '0.9.5', streams: true, layout: { pane: 'w1:p2' } });

/** The task list, shown or folded as `user` left it, and the toasts its agents are told in, as the page has them. */
function Page() {
  useAgentToasts();
  return <><Left /><Toaster id={AGENT_TOASTER} position="top-right" /></>;
}

/**
 * The page over a vault of `pay retries`, its agent in a herdr pane here
 * when `here` says how it is, the task list folded unless `shown`. What the
 * herdr says next of a task's agent is moved with what it returns.
 */
async function open({ here, shown = false, everyS = 10 }: { here?: TerminalState; shown?: boolean; everyS?: number }) {
  useUI.setState((s) => ({ prefs: { ...s.prefs, left: shown } }));
  const ix: Index = index([task('t1', 'pay retries'), task('t2', 'export orders')], { status: { ...status(), everyS } });
  let agents: Record<string, TerminalState> = here === undefined ? {} : { t1: here };
  serve({ '/api/index': () => Response.json(ix), '/api/terminals': () => Response.json(agents) });
  have(ix);
  const screen = await draw(<Page />);
  // The page has read what herdr says as it opened, which is no news, and drawn it.
  await expect.poll(() => queryClient.getQueryData(['terminals'])).toBeDefined();
  await new Promise((r) => setTimeout(r, 250));
  return {
    screen,
    herdr: async (now: TerminalState, id = 't1') => {
      agents = { ...agents, [id]: now };
      await queryClient.invalidateQueries({ queryKey: ['terminals'] });
    },
  };
}

describe('a task folded to its square on the rail', () => {
  afterEach(reset);

  it('is one character of its title', async () => {
    const { screen } = await open({});
    const rail = screen.getByRole('navigation', { name: 'Tasks' });
    expect(rail.getByRole('link', { name: 'pay retries' }).element().textContent).toBe('P');
    expect(rail.getByRole('link', { name: 'export orders' }).element().textContent).toBe('E');
  });

  it('speaks in a bubble as its agent finishes, in place of a toast, and opens its terminal when clicked', async () => {
    const { herdr } = await open({ here: agent('working', 100, 'idle') });
    await herdr(agent('done', 200));
    const bubble = page.getByRole('status', { name: 'pay retries' });
    await expect.element(bubble).toMatchTextContent(/Finished\./);
    expect(page.getByText('Its agent has finished.').query(), 'no toast while the list is folded').toBeNull();

    await bubble.getByRole('button', { name: /Finished/ }).click();
    expect(location.hash).toBe('#/t/t1/terminal');
    await expect.element(bubble).not.toBeInTheDocument();
  });
});

describe('bubbles on the rail at once', () => {
  afterEach(reset);

  it('roll what a task says next into its bubble, pushing out the words before', async () => {
    const { herdr } = await open({ here: agent('working', 100, 'idle') });
    await herdr(agent('done', 200));
    const bubble = page.getByRole('status', { name: 'pay retries' });
    await expect.element(bubble).toMatchTextContent(/Finished\./);
    await herdr(agent('blocked', 310, 'done'));
    await expect.element(bubble).toMatchTextContent(/Needs you\./);
    await expect.poll(() => bubble.element().textContent, { message: 'the old words pushed out' }).not.toMatch(/Finished/);
    expect(page.getByRole('status').elements()).toHaveLength(1);
  });

  it('stand level with their squares, the rail opening room between them, each tail straight at its own', async () => {
    const { screen, herdr } = await open({ here: agent('working', 100, 'idle') });
    await herdr(agent('done', 300));
    await herdr(agent('done', 301), 't2');
    const rail = screen.getByRole('navigation', { name: 'Tasks' });
    const one = page.getByRole('status', { name: 'pay retries' });
    const two = page.getByRole('status', { name: 'export orders' });
    await expect.element(two).toMatchTextContent(/Finished/);
    // Placed, popped and settled.
    await new Promise((r) => setTimeout(r, 700));
    const [a, b] = [one.element().getBoundingClientRect(), two.element().getBoundingClientRect()];
    expect(a.bottom <= b.top || b.bottom <= a.top, 'neither covers the other').toBe(true);
    for (const [bubble, name] of [[one, 'pay retries'], [two, 'export orders']] as const) {
      const square = rail.getByRole('link', { name: new RegExp(name) }).element().getBoundingClientRect();
      const box = bubble.element().getBoundingClientRect();
      expect(Math.abs(box.top + box.height / 2 - (square.top + square.height / 2)), `${name}'s bubble level with its square`).toBeLessThan(2);
    }
  });

  it('put a square that speaks first on the rail as its bubble pops, and one that begins after under it, neither bubble moving', async () => {
    const { screen, herdr } = await open({ here: agent('working', 100, 'idle') });
    const rail = screen.getByRole('navigation', { name: 'Tasks' });
    const order = (): string[] => rail.getByRole('link').elements().map((e) => (e.getAttribute('aria-label') ?? '').split(' · ')[0] ?? '').filter((l) => l === 'pay retries' || l === 'export orders');
    expect(order()).toEqual(['pay retries', 'export orders']);

    await herdr(agent('done', 300), 't2');
    const first = page.getByRole('status', { name: 'export orders' });
    await expect.element(first).toMatchTextContent(/Finished/);
    expect(order(), 'first as it speaks').toEqual(['export orders', 'pay retries']);
    await new Promise((r) => setTimeout(r, 700));
    const before = first.element().getBoundingClientRect().top;

    await herdr(agent('done', 301));
    await expect.element(page.getByRole('status', { name: 'pay retries' })).toMatchTextContent(/Finished/);
    await new Promise((r) => setTimeout(r, 700));
    expect(order(), 'the second under the first').toEqual(['export orders', 'pay retries']);
    expect(first.element().getBoundingClientRect().top, 'the first bubble where it was').toBe(before);
  });
});

describe('an agent that finishes, with the task list shown', () => {
  afterEach(reset);

  it('is told in a toast that says only that it finished, with its button under those words at the right', async () => {
    const { herdr } = await open({ here: agent('working', 100, 'idle'), shown: true });
    await herdr(agent('done', 200));
    const told = page.getByText('Its agent has finished.');
    await expect.element(told).toBeVisible();

    expect(page.getByRole('status', { name: 'pay retries' }).query(), 'no bubble with the list shown').toBeNull();
    const button = page.getByRole('button', { name: 'Open terminal' });
    const [w, bt] = [told.element().getBoundingClientRect(), button.element().getBoundingClientRect()];
    expect(bt.top, 'under the words').toBeGreaterThanOrEqual(w.bottom);
    expect(bt.left, 'at the right').toBeGreaterThan(w.left + w.width / 2);
    await button.click();
    expect(location.hash).toBe('#/t/t1/terminal');
  });
});
