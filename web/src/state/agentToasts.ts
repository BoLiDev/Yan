import { useEffect, useEffectEvent, useRef } from 'react';
import { toast } from 'sonner';
import { agentNews, markAgentSeen } from '../lib/agents';
import type { TerminalState } from '../lib/api';
import { link, parseRoute } from '../lib/route';
import { queryClient, useIndex, useTerminals } from './server';
import { setSeen, useUI } from './ui';

/** The toaster at the page's top right, apart from the foot's, where what an agent did is told. */
export const AGENT_TOASTER = 'agents';

/**
 * Where `user` is in `task` now, the page showing: at its terminal, or on
 * another of its pages; null when the page is hidden or shows something else.
 * Whether the window has the focus is not asked: a page in sight is looked at.
 */
export function lookingAt(task: string): 'terminal' | 'task' | null {
  if (document.visibilityState !== 'visible') return null;
  const r = parseRoute(location.hash);
  if (r.view !== 'task' || r.id !== task) return null;
  return r.sub === 'terminal' ? 'terminal' : 'task';
}

/** `task`'s agent looked at, in its terminal: what it last did is no longer news. */
export function sawAgent(task: string): void {
  const at = queryClient.getQueryData<Readonly<Record<string, TerminalState>>>(['terminals'])?.[task]?.change?.at ?? null;
  setSeen((m) => markAgentSeen(m, task, at));
}

/** Every agent looked at, as Latest's Mark all seen says: what waits on `user` stays news until answered. */
export function sawAllAgents(): void {
  for (const task of Object.keys(queryClient.getQueryData<Readonly<Record<string, TerminalState>>>(['terminals']) ?? {})) sawAgent(task);
}

/**
 * A toast at the top right when a task's agent finishes, or comes to wait
 * on `user` for a question or a permission: `user` works elsewhere while
 * agents run, and the page is where they look up. Its button opens the
 * task's terminal. What the page found when it opened is Latest's to show,
 * not a burst of toasts, and nothing is told of the task the page shows. One
 * toast a task, a later one taking its place.
 */
export function useAgentToasts(): void {
  const { data: terminals } = useTerminals();
  const { data: index } = useIndex();
  // What the page found is read as soon as it can be, the marks and the index in: a state that stays the same is
  // not asked again, so waiting for the next one would take the first change after for what was there.
  const ready = useUI((s) => s.seen !== null) && index !== undefined;
  const told = useRef<Map<string, number> | null>(null);

  const tell = useEffectEvent((states: Readonly<Record<string, TerminalState>>) => {
    const seen = useUI.getState().seen;
    if (!seen || !index) return;
    const changes = Object.entries(states).filter(([, s]) => s.title === undefined && s.change !== undefined);
    if (told.current === null) {
      told.current = new Map(changes.map(([task, s]) => [task, s.change?.at ?? 0]));
      return;
    }
    for (const [task, s] of changes) {
      const at = s.change?.at ?? 0;
      if (at <= (told.current.get(task) ?? -1)) continue;
      told.current.set(task, at);
      const news = agentNews(task, s, seen);
      if (news.kind !== 'finished' && news.kind !== 'blocked') continue;
      // Nothing is told of the task being read: at its terminal it is seen as it happens; on another of its pages,
      // its Terminal row's dot says it.
      const where = lookingAt(task);
      if (where === 'terminal') setSeen((m) => markAgentSeen(m, task, at));
      if (where !== null) continue;
      const title = index.tasks.find((t) => t.id === task)?.title || task;
      toast(title, {
        id: `agent:${task}`,
        toasterId: AGENT_TOASTER,
        description: news.kind === 'blocked' ? 'Its agent needs you: a question or a permission.' : 'Its agent has finished.',
        action: { label: 'Open terminal', onClick: () => { location.hash = link.terminal(task); } },
        duration: 10_000,
      });
    }
  });
  useEffect(() => {
    if (terminals && ready) tell(terminals);
  }, [terminals, ready]);
}
