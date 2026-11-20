import { useEffect, useEffectEvent, useRef } from 'react';
import { toast } from 'sonner';
import { agentNews, markAgentSeen } from '../lib/agents';
import type { Index, TerminalState } from '../lib/api';
import { link, parseRoute } from '../lib/route';
import { goesOn } from '../lib/stops';
import { popBubble } from './bubbles';
import { queryClient, useTerminals } from './server';
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

/**
 * What the page says of a task's agent, in a toast and in its square's
 * bubble: that it finished or needs `user`, the same words each time. It
 * is a nudge to go and look; what the agent has to say is read in its
 * terminal.
 */
const TOLD = { finished: 'Its agent has finished.', blocked: 'Its agent needs you.' } as const;
const SAID = { finished: 'Finished.', blocked: 'Needs you.' } as const;

/**
 * Tell `user` of `task`'s agent: in a toast at the top right while the task
 * list is shown, and with it folded, in a bubble from the task's square on
 * the rail, unless the task has none there. The toast's button, or a click
 * on the bubble, opens the task's terminal.
 */
function tell(task: string, kind: 'finished' | 'blocked'): void {
  const { prefs } = useUI.getState();
  const t = queryClient.getQueryData<Index>(['index'])?.tasks.find((x) => x.id === task);
  const title = t?.title || task;
  const to = link.terminal(task);
  if (!prefs.left && t !== undefined && goesOn(t)) return popBubble(task, { title, text: SAID[kind], to });
  toast(title, {
    id: `agent:${task}`,
    toasterId: AGENT_TOASTER,
    description: TOLD[kind],
    // Its button under its words, at the right, not beside them where it squeezes them into a column.
    classNames: { toast: 'flex-wrap!', content: 'basis-full!', actionButton: 'ml-auto!' },
    action: { label: 'Open terminal', onClick: () => { location.hash = to; } },
    duration: 10_000,
  });
}

/** What has been told of each task's agent: its last change, in seconds as serve saw it. */
type Told = Map<string, number>;

/**
 * Tells `user` when a task's agent finishes, or comes to wait on them for a
 * question or a permission: `user` works elsewhere while agents run, and the
 * page is where they look up. What the page found when it opened is marked
 * in it, not told in a burst, and nothing is told of the task the page
 * shows. One telling a task, a later one taking its place.
 */
export function useAgentToasts(): void {
  const { data: terminals } = useTerminals();
  // What the page found is read as soon as it can be, the marks in: a state that stays the same is
  // not asked again, so waiting for the next one would take the first change after for what was there.
  const ready = useUI((s) => s.seen !== null);
  const told = useRef<Told | null>(null);

  const look = useEffectEvent((states: Readonly<Record<string, TerminalState>>) => {
    const seen = useUI.getState().seen;
    if (!seen) return;
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
      if (where === null) tell(task, news.kind);
    }
  });
  useEffect(() => {
    if (terminals && ready) look(terminals);
  }, [terminals, ready]);
}
