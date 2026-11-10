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
 * vault and herdr say next is moved with the two it returns.
 */
async function open({ here, shown = false, everyS = 10 }: { here?: TerminalState; shown?: boolean; everyS?: number }) {
  useUI.setState((s) => ({ prefs: { ...s.prefs, left: shown } }));
  let ix: Index = index([task('t1', 'pay retries'), task('t2', 'export orders')], { status: { ...status(), everyS } });
  let agents: Record<string, TerminalState> = here === undefined ? {} : { t1: here };
  serve({ '/api/index': () => Response.json(ix), '/api/terminals': () => Response.json(agents) });
  have(ix);
  const screen = await draw(<Page />);
  // The page has read what herdr says as it opened, which is no news, and drawn it.
  await expect.poll(() => queryClient.getQueryData(['terminals'])).toBeDefined();
  await new Promise((r) => setTimeout(r, 250));
  return {
    screen,
    herdr: async (now: TerminalState) => {
      agents = { t1: now };
      await queryClient.invalidateQueries({ queryKey: ['terminals'] });
    },
    says: (text: string, at: number) => {
      ix = { ...ix, tasks: ix.tasks.map((t) => (t.id === 't1' ? { ...t, said: { text, at } } : t)) };
      queryClient.setQueryData(['index'], ix);
    },
    saysAs: (id: string, text: string, at: number) => {
      ix = { ...ix, tasks: ix.tasks.map((t) => (t.id === id ? { ...t, said: { text, at } } : t)) };
      queryClient.setQueryData(['index'], ix);
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

  it('speaks in a bubble once its agent has finished and its words come, nothing on the rail while they are on their way, and opens its terminal when clicked', async () => {
    const { herdr, says } = await open({ here: agent('working', 100, 'idle') });

    await herdr(agent('done', 200));
    const bubble = page.getByRole('status', { name: 'pay retries' });
    await new Promise((r) => setTimeout(r, 500));
    expect(bubble.query(), 'no bubble before there is something to say').toBeNull();

    says('Retries are in; the PR waits on your review.', 201);
    await expect.element(bubble).toMatchTextContent(/Retries are in; the PR waits on your review\./);
    expect(page.getByText('Its agent has finished.').query(), 'no toast while the list is folded').toBeNull();

    await bubble.getByRole('button', { name: /Retries are in/ }).click();
    expect(location.hash).toBe('#/t/t1/terminal');
    await expect.element(bubble).not.toBeInTheDocument();
  });

  it('says what an agent elsewhere said as it comes, and opens the task', async () => {
    const { says } = await open({});
    says('Stuck: staging refuses our key.', 300);
    const bubble = page.getByRole('status', { name: 'pay retries' });
    await expect.element(bubble).toMatchTextContent(/Stuck: staging refuses our key\./);
    await bubble.getByRole('button', { name: /Stuck/ }).click();
    expect(location.hash).toBe('#/t/t1');
  });

  it('says the agent finished in its own words when none come, and only then', async () => {
    const { herdr } = await open({ here: agent('working', 100, 'idle'), everyS: 0 });
    await herdr(agent('done', 200));
    const bubble = page.getByRole('status', { name: 'pay retries' });
    await new Promise((r) => setTimeout(r, 500));
    expect(bubble.query(), 'nothing while the words may yet come').toBeNull();
    await expect.element(bubble, { timeout: 8000 }).toMatchTextContent(/I'm done for now\./);
  });
});

describe('bubbles on the rail at once', () => {
  afterEach(reset);

  it('roll the words a task says again into its bubble, pushing out the ones before', async () => {
    const { says } = await open({});
    says('Retries are in.', 300);
    const bubble = page.getByRole('status', { name: 'pay retries' });
    await expect.element(bubble).toMatchTextContent(/Retries are in\./);
    says('And the PR is open.', 310);
    await expect.element(bubble).toMatchTextContent(/And the PR is open\./);
    await expect.poll(() => bubble.element().textContent, { message: 'the old words pushed out' }).not.toMatch(/Retries are in/);
    expect(page.getByRole('status').elements()).toHaveLength(1);
  });

  it('stand level with their squares, the rail opening room between them, each tail straight at its own', async () => {
    const { screen, says, saysAs } = await open({});
    says('Retries are in and tested; the PR waits on your review.', 300);
    saysAs('t2', 'Orders export to CSV now, and the old job is gone.', 301);
    const rail = screen.getByRole('navigation', { name: 'Tasks' });
    const one = page.getByRole('status', { name: 'pay retries' });
    const two = page.getByRole('status', { name: 'export orders' });
    await expect.element(two).toMatchTextContent(/Orders export/);
    // Placed, popped and settled.
    await new Promise((r) => setTimeout(r, 700));
    const [a, b] = [one.element().getBoundingClientRect(), two.element().getBoundingClientRect()];
    expect(a.bottom <= b.top || b.bottom <= a.top, 'neither covers the other').toBe(true);
    for (const [bubble, name] of [[one, 'pay retries'], [two, 'export orders']] as const) {
      const square = rail.getByRole('link', { name }).element().getBoundingClientRect();
      const box = bubble.element().getBoundingClientRect();
      expect(Math.abs(box.top + box.height / 2 - (square.top + square.height / 2)), `${name}'s bubble level with its square`).toBeLessThan(2);
    }
  });

  it('put a square that speaks first on the rail as its bubble pops, and one that begins after under it, neither bubble moving', async () => {
    const { screen, says, saysAs } = await open({});
    const rail = screen.getByRole('navigation', { name: 'Tasks' });
    const order = (): string[] => rail.getByRole('link').elements().map((e) => e.getAttribute('aria-label') ?? '').filter((l) => l === 'pay retries' || l === 'export orders');
    expect(order()).toEqual(['pay retries', 'export orders']);

    saysAs('t2', 'Orders export to CSV now.', 300);
    const first = page.getByRole('status', { name: 'export orders' });
    await expect.element(first).toMatchTextContent(/Orders export/);
    expect(order(), 'first as it speaks').toEqual(['export orders', 'pay retries']);
    await new Promise((r) => setTimeout(r, 700));
    const before = first.element().getBoundingClientRect().top;

    says('Retries are in and tested; the PR waits on your review.', 301);
    await expect.element(page.getByRole('status', { name: 'pay retries' })).toMatchTextContent(/Retries are in/);
    await new Promise((r) => setTimeout(r, 700));
    expect(order(), 'the second under the first').toEqual(['export orders', 'pay retries']);
    expect(first.element().getBoundingClientRect().top, 'the first bubble where it was').toBe(before);
  });
});

describe('what an agent said, with the task list shown', () => {
  afterEach(reset);

  it('takes the place of the toast\'s words once they come', async () => {
    const { herdr, says } = await open({ here: agent('working', 100, 'idle'), shown: true });
    await herdr(agent('done', 200));
    await expect.element(page.getByText('Its agent has finished.')).toBeVisible();

    says('Retries are in.', 201);
    await expect.element(page.getByText('Retries are in.')).toBeVisible();
    expect(page.getByText('Its agent has finished.').query()).toBeNull();
    expect(page.getByRole('status', { name: 'pay retries' }).query(), 'no bubble with the list shown').toBeNull();
    await page.getByRole('button', { name: 'Open terminal' }).click();
    expect(location.hash).toBe('#/t/t1/terminal');
  });

  it('opens the task\'s agents elsewhere when no terminal here said it', async () => {
    useUI.setState((s) => ({ prefs: { ...s.prefs, left: true } }));
    let ix: Index = index([task('t1', 'pay retries', { agents: [['cloud', 'https://claude.ai/code/session_x']] })]);
    serve({ '/api/index': () => Response.json(ix), '/api/terminals': Response.json({}) });
    have(ix);
    await draw(<Page />);
    await expect.poll(() => queryClient.getQueryData(['terminals'])).toBeDefined();
    await new Promise((r) => setTimeout(r, 250));

    ix = { ...ix, tasks: [{ ...ix.tasks[0]!, said: { text: 'PR #42 is open.', at: 300 } }] };
    queryClient.setQueryData(['index'], ix);
    await expect.element(page.getByText('PR #42 is open.')).toBeVisible();
    await page.getByRole('button', { name: 'Open agent' }).click();
    expect(location.hash).toBe('#/t/t1/agent');
  });

  it('tells words said again, though the clock of the machine they came from is behind', async () => {
    const { says } = await open({ shown: true });
    says('PR #42 is open.', 300);
    await expect.element(page.getByText('PR #42 is open.')).toBeVisible();
    says('CI is green too.', 250);
    await expect.element(page.getByText('CI is green too.')).toBeVisible();
  });
});
