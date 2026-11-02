import { useEffect, useState, type ReactNode } from 'react';
import { postJSON, type WorktreeState } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Icon } from '../../components/Icon';
import { queryClient } from '../../state/server';
import { toast, useUI } from '../../state/ui';

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
      className={cn('flex h-5 items-center justify-center rounded-[5px] text-ink-3 hover:bg-foreground/10 hover:text-foreground', sure ? 'gap-1 bg-destructive px-1.5 text-[12px] text-white hover:bg-destructive/90 hover:text-white' : 'w-5')}
      onClick={(e) => { e.stopPropagation(); if (sure) void close(); else setSure(true); }}>
      {sure ? (agent ? 'Stop' : 'Close') : <Icon name="close" size={13} />}
    </button>
  );
}

/**
 * A task's terminal tabs, as its bar: Agent, its agent's own, always there,
 * then a tab for each of its worktrees opened from MR's page, named for its
 * repository. Each has a × while there is something to close; the one
 * shown is a card. `tools` sit at the bar's end.
 */
export function TabBar({ id, on, agent, worktrees, flush, tools }: { id: string; on: string; agent: boolean; worktrees: readonly WorktreeState[]; flush?: boolean; tools?: ReactNode }) {
  const tabs = [{ tab: AGENT, name: 'Agent', closable: agent }, ...worktrees.map((w) => ({ tab: w.tab, name: w.name, closable: true }))];
  return (
    <div className={cn('flex min-h-14 flex-none items-center gap-3 border-b py-2 pr-3.5 pl-3', flush ? 'border-transparent' : 'border-sunken')}>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" role="tablist" aria-label="Terminal">
        {tabs.map(({ tab, name, closable }) => (
          <div key={tab} role="tab" aria-selected={tab === on} tabIndex={0}
            className={cn('flex h-8 cursor-pointer items-center gap-1.5 rounded-lg pr-1.5 pl-2.5 text-[13.5px] select-none',
              tab === on ? 'bg-card font-bold text-foreground ring-1 ring-border' : 'text-ink-2 hover:bg-hover hover:text-foreground', !closable && 'pr-2.5')}
            onClick={() => showTab(id, tab)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTab(id, tab); } }}>
            <Icon name={tab === AGENT ? 'terminal' : 'folder'} size={14} className="text-ink-3" />
            {name}
            {closable ? <CloseTab id={id} tab={tab} name={name} /> : null}
          </div>
        ))}
      </div>
      {tools}
    </div>
  );
}
