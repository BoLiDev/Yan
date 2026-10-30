// The agent tab, AGENT_TAB, held once this page has opened an agent in it, so going to another task sends it there.

import type { MouseEvent } from 'react';
import { create } from 'zustand';
import { AGENT_TAB } from '../lib/route';

/** Where the held tab was last sent, null while none is held: the agent the page marks as showing there. */
export const useAgentTab = create<{ showing: string | null }>(() => ({ showing: null }));

let tab: Window | null = null;
let watching: number | undefined;

/** The page yan serve shows in the agent tab for a task that keeps no agent, so the tab never shows another task's. */
export const noAgent = (task: string): string => new URL(`/agent?task=${encodeURIComponent(task)}`, location.origin).href;

/** Open `where` in the agent tab, as a click on an agent does, and hold the tab from then on; the browser brings it forward. */
export function openAgent(where: string): void {
  const opened = window.open(where, AGENT_TAB);
  if (!opened) return;
  tab = opened;
  useAgentTab.setState({ showing: where });
  // A tab closed says nothing to the page that opened it; it is asked.
  watching ??= window.setInterval(() => { if (tab?.closed !== false) letGo(); }, 1500);
}

/**
 * Send the held tab to `where`; nothing while none is held, so a page that
 * is not beside its agents never opens a tab of its own. Through the tab's
 * location rather than window.open: a tab found by its name is brought
 * forward (Chromium's FindOrCreateFrameForNavigation focuses it), which in
 * a split view would take the keys from this page on every task gone to.
 * A reload of this page lets the tab go, as the page cannot find a tab by
 * name without that; the next agent opened holds it again.
 */
export function followAgent(where: string): void {
  if (tab === null || tab.closed || useAgentTab.getState().showing === where) return;
  try {
    tab.location.href = where;
    useAgentTab.setState({ showing: where });
  } catch {
    letGo();
  }
}

function letGo(): void {
  tab = null;
  window.clearInterval(watching);
  watching = undefined;
  useAgentTab.setState({ showing: null });
}

/**
 * A click on an agent's link opens it through openAgent, so the tab is
 * held; a click that asks for something else, a new window or a download,
 * is left to the browser.
 */
export function onAgentClick(where: string): (e: MouseEvent) => void {
  return (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    openAgent(where);
  };
}
