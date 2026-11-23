import { afterEach, describe, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import type { Index, TerminalState } from '../lib/api';
import { toast } from 'sonner';
import { Toaster } from '../components/ui/sonner';
import { TooltipProvider } from '../components/ui/tooltip';
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
 * when `here` says how it is, the task list folded unless `shown`, and
 * notifications on unless `notify` says not. What the
 * herdr says next of a task's agent is moved with what it returns.
 */
async function open({ here, shown = false, everyS = 10, notify = true }: { here?: TerminalState; shown?: boolean; everyS?: number; notify?: boolean }) {
  useUI.setState((s) => ({ prefs: { ...s.prefs, left: shown, notify } }));
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

  it('is the mark of where it stands, in that state\'s colour, with no letter: its name is its tooltip\'s', async () => {
    useUI.setState((s) => ({ prefs: { ...s.prefs, left: false } }));
    have(index([task('t1', 'pay retries'), task('t2', 'export orders', { state: 'uat' })]));
    serve({ '/api/terminals': () => Response.json({}) });
    const rail = (await draw(<Left />)).getByRole('navigation', { name: 'Tasks' });
    const open = rail.getByRole('link', { name: 'pay retries' }).element();
    const review = rail.getByRole('link', { name: 'export orders' }).element();
    expect([open.textContent, review.textContent]).toEqual(['', '']);
    const colour = (square: Element): string => getComputedStyle(square.querySelector('svg') as SVGElement).color;
    expect(colour(open)).not.toBe(colour(review));
  });

  it('shows a ring going round in place of its mark while its agent is at work, in the mark\'s colour, and its mark again once the agent stops', async () => {
    const { screen, herdr } = await open({ here: agent('working', 100, 'idle') });
    const square = (): Element => screen.getByRole('navigation', { name: 'Tasks' }).getByRole('link', { name: /pay retries/ }).element();
    // What a square shows, of its two: the one not shrunk away to nothing.
    const shown = (): string[] => [...square().querySelectorAll('[data-face]')].filter((face) => getComputedStyle(face).opacity === '1').map((face) => face.getAttribute('data-face') ?? '');
    await expect.poll(shown).toEqual(['at work']);
    const ring = square().querySelector('[data-face="at work"]') as Element;
    expect(getComputedStyle(ring.querySelector('svg') as Element).animationName).not.toBe('none');
    expect(getComputedStyle(ring).color).toBe(getComputedStyle(square().querySelector('svg') as Element).color);
    await herdr(agent('idle', 200));
    await expect.poll(shown, { timeout: 6000 }).toEqual(['mark']);
  });

  it('says which task it is as the pointer reaches it, with no wait', async () => {
    useUI.setState((s) => ({ prefs: { ...s.prefs, left: false } }));
    have(index([task('t1', 'pay retries')]));
    serve({ '/api/terminals': () => Response.json({}) });
    // Under the page's own wait for a tooltip, as the page draws the rail.
    const screen = await draw(<TooltipProvider delay={5000}><Left /></TooltipProvider>);
    await screen.getByRole('navigation', { name: 'Tasks' }).getByRole('link', { name: 'pay retries' }).hover();
    // Well inside the wait the page's other tooltips would have had.
    await expect.poll(() => [...document.querySelectorAll('[data-slot="tooltip-content"]')].map((e) => e.textContent), { timeout: 1500 }).toEqual(['pay retries']);
  });

  it('stands under the list\'s own tools, the drafts and the settings among them, each opening its box', async () => {
    const { screen } = await open({});
    const rail = screen.getByRole('navigation', { name: 'Tasks' });
    await rail.getByRole('button', { name: 'Drafts' }).click();
    expect(useUI.getState().drafts).toBe(true);
    useUI.setState({ drafts: false });
    await rail.getByRole('button', { name: 'Settings' }).click();
    expect(useUI.getState().settings).toBe(true);
  });

  it('is not one Janus has: Janus is its own button on the rail, to its terminal', async () => {
    useUI.setState((s) => ({ prefs: { ...s.prefs, left: false } }));
    have(index([task('t1', 'pay retries'), task('janus', 'Janus')]));
    serve({ '/api/terminals': () => Response.json({}) });
    const screen = await draw(<Left />);
    const rail = screen.getByRole('navigation', { name: 'Tasks' });
    await expect.element(rail.getByRole('link', { name: 'pay retries' })).toBeVisible();
    expect(rail.getByRole('link').elements().map((e) => e.getAttribute('href'))).toEqual(['#/t/janus/terminal', '#/t/t1']);
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

  it('is told in nothing that pops up with notifications turned off, list shown or folded, its row still marked', async () => {
    const { screen, herdr } = await open({ here: agent('working', 100, 'idle'), shown: true, notify: false });
    // One a test before left up is not this one's.
    toast.dismiss();
    await expect.poll(() => page.getByText('Its agent has finished.').query()).toBeNull();
    await herdr(agent('done', 200));
    await expect.poll(() => document.querySelector('a[aria-description="agent finished"]')?.textContent ?? '').toContain('pay retries');
    expect(page.getByText('Its agent has finished.').query()).toBeNull();

    useUI.setState((s) => ({ prefs: { ...s.prefs, left: false } }));
    await herdr(agent('blocked', 300, 'done'));
    await expect.element(screen.getByRole('link', { name: /pay retries · agent needs you/ })).toBeVisible();
    await new Promise((r) => setTimeout(r, 300));
    expect(page.getByRole('status', { name: 'pay retries' }).query(), 'no bubble either').toBeNull();
  });
});
