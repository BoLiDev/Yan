import { useEffect, useState, type ReactNode } from 'react';
import { postJSON } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Icon } from '../../components/Icon';
import { queryClient } from '../../state/server';
import { toast, useUI } from '../../state/ui';

/** Which of a task's terminal tabs: its agent's, or the one with a shell in each of its worktrees. */
export type TermTab = 'agent' | 'worktree';

const NAMES: Readonly<Record<TermTab, string>> = { agent: 'Agent', worktree: 'Worktree' };

/** Show `tab` of task `id`'s terminal, kept for this visit, so going back to the terminal finds it as left. */
export function showTab(id: string, tab: TermTab): void {
  useUI.setState((s) => ({ termTab: { ...s.termTab, [id]: tab } }));
}

/**
 * A tab's ×: closing it is asked twice, as Stop is, the first click only
 * turning it to say so, which goes back after a few seconds untouched.
 * The agent's stops it, its tab closed; the Worktree's closes that tab,
 * every shell in it with it, and the agent's is shown again.
 */
function CloseTab({ id, tab }: { id: string; tab: TermTab }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const back = window.setTimeout(() => setSure(false), 3000);
    return () => window.clearTimeout(back);
  }, [sure]);
  const close = async (): Promise<void> => {
    setSure(false);
    try {
      await postJSON(tab === 'agent' ? '/api/terminal/stop' : '/api/worktree/close', { task: id });
    } catch (err) {
      return void toast(`Could not close ${NAMES[tab]}: ${(err as Error).message}`, true);
    }
    if (tab === 'worktree') showTab(id, 'agent');
    void queryClient.invalidateQueries({ queryKey: [tab === 'agent' ? 'terminals' : 'worktrees'] });
  };
  const label = sure ? `Really ${tab === 'agent' ? 'stop the agent' : 'close the worktrees'}` : `Close ${NAMES[tab]}`;
  return (
    <button type="button" aria-label={label} title={sure ? `${label}? Click again` : label}
      className={cn('flex h-5 items-center justify-center rounded-[5px] text-ink-3 hover:bg-foreground/10 hover:text-foreground', sure ? 'gap-1 bg-destructive px-1.5 text-[12px] text-white hover:bg-destructive/90 hover:text-white' : 'w-5')}
      onClick={(e) => { e.stopPropagation(); if (sure) void close(); else setSure(true); }}>
      {sure ? (tab === 'agent' ? 'Stop' : 'Close') : <Icon name="close" size={13} />}
    </button>
  );
}

/**
 * A task's terminal tabs, as its bar: Agent, its agent's own tab, always
 * there, and Worktree once one is opened for it. Each has a fixed name, as
 * each has its one use, and a × while there is something to close; the
 * one shown is a card. `tools` sit at the bar's end.
 */
export function TabBar({ id, on, agent, worktree, flush, tools }: { id: string; on: TermTab; agent: boolean; worktree: boolean; flush?: boolean; tools?: ReactNode }) {
  const tabs: readonly { tab: TermTab; closable: boolean }[] = [{ tab: 'agent', closable: agent }, ...(worktree ? [{ tab: 'worktree' as const, closable: true }] : [])];
  return (
    <div className={cn('flex min-h-14 flex-none items-center gap-3 border-b py-2 pr-3.5 pl-3', flush ? 'border-transparent' : 'border-sunken')}>
      <div className="flex min-w-0 flex-1 items-center gap-1" role="tablist" aria-label="Terminal">
        {tabs.map(({ tab, closable }) => (
          <div key={tab} role="tab" aria-selected={tab === on} tabIndex={0}
            className={cn('flex h-8 cursor-pointer items-center gap-1.5 rounded-lg pr-1.5 pl-2.5 text-[13.5px] select-none',
              tab === on ? 'bg-card font-bold text-foreground ring-1 ring-border' : 'text-ink-2 hover:bg-hover hover:text-foreground', !closable && 'pr-2.5')}
            onClick={() => showTab(id, tab)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showTab(id, tab); } }}>
            <Icon name={tab === 'agent' ? 'terminal' : 'folder'} size={14} className="text-ink-3" />
            {NAMES[tab]}
            {closable ? <CloseTab id={id} tab={tab} /> : null}
          </div>
        ))}
      </div>
      {tools}
    </div>
  );
}
