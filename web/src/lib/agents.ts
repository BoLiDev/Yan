// What a task's agent is up to, as the task list, its rail, Latest and the
// page's toasts all tell it: one reading of what herdr says, so they agree.

import type { Index, TerminalState } from './api';
import { unseenOf, type Seen } from './seen';

/**
 * At work; waiting on `user`, a question or a permission; finished, from
 * work or from waiting; or idle, never having done either while serve
 * watched.
 */
export type AgentKind = 'working' | 'blocked' | 'finished' | 'idle';

export interface AgentNews {
  readonly kind: AgentKind;
  /** When it came to be so, in seconds, as serve saw it; null when serve has not seen it change. */
  readonly at: number | null;
  /** Finished since its terminal was last looked at, or waiting on `user`, which is news until answered. */
  readonly news: boolean;
}

/** What `state`'s agent is up to, against what of it this browser has looked at. */
export function agentNews(task: string, state: TerminalState, seen: Seen | null): AgentNews {
  const at = state.change?.at ?? null;
  if (state.status === 'working') return { kind: 'working', at, news: false };
  if (state.status === 'blocked') return { kind: 'blocked', at, news: true };
  // herdr's own done is a finish nobody has looked at in herdr; an idle one that came from anything else is a finish too.
  const finished = state.status === 'done' || (state.status === 'idle' && state.change !== undefined && state.change.from !== 'idle' && state.change.from !== 'unknown');
  if (!finished) return { kind: 'idle', at, news: false };
  const looked = seen?.agents?.[task];
  return { kind: 'finished', at, news: at === null ? state.status === 'done' && looked === undefined : at > (looked ?? 0) };
}

/** Each task's news, by task; a launch is left out, its task having its own once bare yan keeps the pane. */
export function allNews(terminals: Readonly<Record<string, TerminalState>> | undefined, seen: Seen | null): ReadonlyMap<string, AgentNews> {
  return new Map(Object.entries(terminals ?? {}).filter(([, s]) => s.title === undefined).map(([task, s]) => [task, agentNews(task, s, seen)]));
}

/** The marks with `task`'s agent looked at, up to its change at `at` (or now, when serve saw none). */
export function markAgentSeen(seen: Seen, task: string, at: number | null): Seen | null {
  const to = at ?? Math.floor(Date.now() / 1000);
  if ((seen.agents?.[task] ?? -1) >= to) return null;
  return { ...seen, agents: { ...seen.agents, [task]: to } };
}

/** What a row or a rail says of it, in a few words. */
export function agentWords(n: AgentNews): string {
  return { working: 'agent at work', blocked: 'agent needs you', finished: 'agent finished', idle: 'agent idle' }[n.kind];
}

/** How many tasks Latest has news of: something arrived in their artifacts, or their agent finished or waits on `user`. */
export function tasksWithNews(index: Index, seen: Seen, news: ReadonlyMap<string, AgentNews>): number {
  const pushed = index.tasks.filter((t) => unseenOf(index, seen, t.id).size > 0).map((t) => t.id);
  const agents = [...news].filter(([task, n]) => n.news && index.tasks.some((t) => t.id === task)).map(([task]) => task);
  return new Set([...pushed, ...agents]).size;
}
