import { afterEach, describe, expect, it, vi } from 'vitest';

/** The agent tab as the page that opened it sees it. */
const aTab = (): { closed: boolean; location: { href: string } } => ({ closed: false, location: { href: '' } });

describe('the agent tab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    sessionStorage.clear();
    vi.resetModules();
  });

  it('is still marked as showing its agent after the page is reloaded, and no longer once it is seen closed', async () => {
    const tab = aTab();
    vi.stubGlobal('open', () => tab);
    vi.useFakeTimers();
    const first = await import('./agentTab');
    first.openAgent('https://agent.example/t2');
    expect(first.useAgentTab.getState().showing).toBe('https://agent.example/t2');

    // The page loaded again: its modules start afresh, in the same browser tab.
    vi.resetModules();
    const again = await import('./agentTab');
    expect(again.useAgentTab.getState().showing).toBe('https://agent.example/t2');

    // Held again by the next agent opened, it is watched, and let go of once closed, for the next reload too.
    again.openAgent('https://agent.example/t3');
    tab.closed = true;
    vi.advanceTimersByTime(2000);
    expect(again.useAgentTab.getState().showing).toBeNull();
    vi.resetModules();
    expect((await import('./agentTab')).useAgentTab.getState().showing).toBeNull();
  });
});
