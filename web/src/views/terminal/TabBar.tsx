import { useEffect, useState, type ReactNode } from 'react';
import { postJSON, type WorktreeState } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Icon } from '../../components/Icon';
import { queryClient } from '../../state/server';
import { toast, useUI } from '../../state/ui';
import { Strip } from './Tiles';

/** The agent's tab, among a task's terminal tabs; each other is a worktree tab, by its herdr tab id. */
export const AGENT = 'agent';

/** Show tab `tab` of task `id`'s terminal, kept for this visit, so going back to the terminal finds it as left. */
export function showTab(id: string, tab: string): void {
  useUI.setState((s) => ({ termTab: { ...s.termTab, [id]: tab } }));
}

/**
 * A tab's ×: closing it is asked twice, as stopping the agent was, the
 * first click only turning it to say so, which goes back after a few
 * seconds untouched. The agent's stops it, its tab closed; a worktree's
 * closes that tab, every shell in it with it, and the agent's is shown.
 * It is drawn in its tab's colour, whichever that is.
 */
function CloseTab({ id, tab, name }: { id: string; tab: string; name: string }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const back = window.setTimeout(() => setSure(false), 3000);
    return () => window.clearTimeout(back);
  }, [sure]);
  const agent = tab === AGENT;
  const close = async (): Promise<void> => {
    setSure(false);
    try {
      await postJSON(agent ? '/api/terminal/stop' : '/api/worktree/close', agent ? { task: id } : { task: id, tab });
    } catch (err) {
      return void toast(`Could not close ${name}: ${(err as Error).message}`, true);
    }
    if (!agent) showTab(id, AGENT);
    void queryClient.invalidateQueries({ queryKey: [agent ? 'terminals' : 'worktrees'] });
  };
  const label = sure ? (agent ? 'Really stop the agent' : `Really close ${name}`) : `Close ${name}`;
  return (
    <button type="button" aria-label={label} title={sure ? `${label}? Click again` : label}
      className={cn('flex h-5 flex-none items-center justify-center rounded-full', sure ? 'gap-1 bg-destructive px-2 text-[12px] text-white hover:bg-destructive/90' : 'w-5 text-current/55 hover:bg-current/15 hover:text-current')}
      onClick={(e) => { e.stopPropagation(); if (sure) void close(); else setSure(true); }}>
      {sure ? (agent ? 'Stop' : 'Close') : <Icon name="close" size={13} />}
    </button>
  );
}

/** A tab, as a browser's: as wide as there is room for, up to a width of its own, its name cut short before it is squeezed out. */
const TAB = 'relative flex h-9 min-w-[76px] shrink basis-[200px] cursor-pointer items-center gap-2 rounded-t-[10px] pr-2 pl-3 text-[13px] outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

/**
 * The tab shown is drawn in `--tab-on`, the colour of what it shows, and
 * flares into it at its foot, a curve on each side, so the two are one
 * shape; its sides are drawn over its neighbours'.
 */
const ON = cn('z-10 bg-[var(--tab-on)] text-[var(--tab-on-ink)]',
  'before:absolute before:bottom-0 before:-left-2.5 before:size-2.5 before:bg-[radial-gradient(circle_at_0_0,transparent_10px,var(--tab-on)_10.5px)]',
  'after:absolute after:-right-2.5 after:bottom-0 after:size-2.5 after:bg-[radial-gradient(circle_at_100%_0,transparent_10px,var(--tab-on)_10.5px)]');

/** Shown over the terminal, the tab is its dark; over the page's own, while there is no pane to draw, the page's. */
const UNDER = { dark: '[--tab-on:var(--term-bg)] [--tab-on-ink:var(--term-fg)]', page: '[--tab-on:var(--surface)] [--tab-on-ink:var(--ink)]' };

/** One not shown lies on the strip, and lights up under the pointer. */
const OFF = 'text-ink-2 hover:bg-hover hover:text-foreground';

/** A line between two tabs not shown, gone while either is pointed at. */
const LINE = 'after:absolute after:top-1/2 after:right-0 after:h-4 after:w-px after:-translate-y-1/2 after:bg-ink-4/45 hover:after:opacity-0 [&:has(+*:hover)]:after:opacity-0';

/**
 * A task's terminal tabs, along the foot of its strip as a browser's are:
 * Agent, its agent's own, always there, then a tab for each of its worktrees
 * opened from MR's page, named for its repository. Each has a × while there
 * is something to close. `dark` says the tab shown is over the terminal's
 * dark rather than the page. `tools` sit at the strip's end.
 */
export function TabBar({ id, on, agent, worktrees, dark, tools }: { id: string; on: string; agent: boolean; worktrees: readonly WorktreeState[]; dark?: boolean; tools?: ReactNode }) {
  const tabs = [{ tab: AGENT, name: 'Agent', closable: agent }, ...worktrees.map((w) => ({ tab: w.tab, name: w.name, closable: true }))];
  const shown = tabs.findIndex((t) => t.tab === on);
  return (
    <Strip>
      <div className="flex min-w-0 flex-1 items-end pl-2.5" role="tablist" aria-label="Terminal">
        {tabs.map(({ tab, name, closable }, i) => (
          <div key={tab} role="tab" aria-selected={i === shown} tabIndex={0} title={name}
            className={cn(TAB, i === shown ? cn(ON, UNDER[dark ? 'dark' : 'page']) : OFF, i !== shown && i + 1 < tabs.length && i + 1 !== shown && LINE, !closable && 'pr-3')}
            onClick={() => showTab(id, tab)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTab(id, tab); } }}>
            <Icon name={tab === AGENT ? 'terminal' : 'folder'} size={14} className="flex-none opacity-70" />
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {closable ? <CloseTab id={id} tab={tab} name={name} /> : null}
          </div>
        ))}
      </div>
      <div className="flex self-center">{tools}</div>
    </Strip>
  );
}
