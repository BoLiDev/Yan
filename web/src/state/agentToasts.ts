import { useEffect, useEffectEvent, useRef } from 'react';
import { toast } from 'sonner';
import { agentNews, markAgentSeen } from '../lib/agents';
import type { Index, TerminalState } from '../lib/api';
import { link, parseRoute } from '../lib/route';
import { goesOn } from '../lib/stops';
import { popBubble } from './bubbles';
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

/** What the page says of an agent when it says nothing itself, in a toast, and in its square's bubble, as the agent. */
const TOLD = { finished: 'Its agent has finished.', blocked: 'Its agent needs you: a question or a permission.' } as const;
const SAID = { finished: 'I\'m done for now.', blocked: 'I need you: a question or a permission.' } as const;

/** Finishes told on the rail whose words are not in yet: each waited for, without a sign, until they come or time is up. */
const awaited = new Map<string, ReturnType<typeof setTimeout>>();

/** Nothing waited for any more: a test's page starts with none. */
export function forgetAwaited(): void {
  for (const id of awaited.values()) clearTimeout(id);
  awaited.clear();
}

/**
 * Tell `user` of `task`'s agent: in a toast at the top right while the task
 * list is shown, and with it folded, in a bubble from the task's square on
 * the rail, unless the task has none there. What the agent said is told in
 * its own words. A finish whose words are not in yet waits for them on the
 * rail, with nothing on it, for about as long as serve takes to fetch them,
 * and its bubble pops with them as they come, or with the page's own when
 * they do not, since three dots moving there while nothing is said only take
 * the eye; the toast says it finished until the words replace that. Its
 * button, or a click on the bubble, opens the task's terminal when its agent
 * runs here; else its agents elsewhere, in the cloud, when it keeps any,
 * which is where words from no terminal here come from; else the task.
 */
function tell(task: string, kind: 'finished' | 'blocked' | 'said', words: string | undefined, terminal: boolean, waited = false): void {
  clearTimeout(awaited.get(task));
  awaited.delete(task);
  const { prefs, last, status } = useUI.getState();
  const t = queryClient.getQueryData<Index>(['index'])?.tasks.find((x) => x.id === task);
  const title = t?.title || task;
  const away = !terminal && (t?.agents.length ?? 0) > 0;
  const to = terminal ? link.terminal(task) : away ? link.agent(task) : (last[task] ?? link.task(task));
  const plain = kind === 'said' ? 'finished' : kind;
  if (!prefs.left && t !== undefined && goesOn(t)) {
    if (kind === 'finished' && words === undefined && !waited) {
      // serve fetches every `everyS`, and the hook commits the words as the turn ends: by then they are in, or are not coming.
      const wait = Math.min(20, (status?.everyS ?? 10) + 4) * 1000;
      awaited.set(task, setTimeout(() => {
        awaited.delete(task);
        if (lookingAt(task) === null) tell(task, 'finished', undefined, terminal, true);
      }, wait));
      return;
    }
    popBubble(task, { title, text: words ?? SAID[plain], to });
    return;
  }
  toast(title, {
    id: `agent:${task}`,
    toasterId: AGENT_TOASTER,
    description: words ?? TOLD[plain],
    action: { label: terminal ? 'Open terminal' : away ? 'Open agent' : 'Open task', onClick: () => { location.hash = to; } },
    duration: 10_000,
  });
}

/**
 * Words said, as told apart: by what they are and when, not by which is
 * later, since they may come from an agent on another machine, in the
 * cloud, whose clock is not this one's, and only the last is kept.
 */
const saying = (said: { readonly text: string; readonly at: number }): string => `${said.at}\n${said.text}`;

/** What has been told of each task's agent: its last change, in seconds as serve saw it, and the last words it said. */
interface Told {
  readonly changes: Map<string, number>;
  readonly said: Map<string, string>;
  /** When the page opened, in seconds: the turn of an agent first seen to change after it began no earlier. */
  readonly opened: number;
}

/**
 * Tells `user` when a task's agent finishes, or comes to wait on them for a
 * question or a permission, and when it says something with `yan say`:
 * `user` works elsewhere while agents run, and the page is where they look
 * up. What the page found when it opened is Latest's to show, not a burst,
 * and nothing is told of the task the page shows. One telling a task, a
 * later one taking its place.
 */
export function useAgentToasts(): void {
  const { data: terminals } = useTerminals();
  const { data: index } = useIndex();
  // What the page found is read as soon as it can be, the marks and the index in: a state that stays the same is
  // not asked again, so waiting for the next one would take the first change after for what was there.
  const ready = useUI((s) => s.seen !== null) && index !== undefined;
  const told = useRef<Told | null>(null);

  const look = useEffectEvent((states: Readonly<Record<string, TerminalState>>, ix: Index) => {
    const seen = useUI.getState().seen;
    if (!seen) return;
    const changes = Object.entries(states).filter(([, s]) => s.title === undefined && s.change !== undefined);
    if (told.current === null) {
      told.current = {
        changes: new Map(changes.map(([task, s]) => [task, s.change?.at ?? 0])),
        said: new Map(ix.tasks.flatMap((t) => (t.said ? [[t.id, saying(t.said)] as const] : []))),
        opened: Math.floor(Date.now() / 1000),
      };
      return;
    }
    const { changes: toldChange, said: toldSaid, opened } = told.current;
    for (const [task, s] of changes) {
      const at = s.change?.at ?? 0;
      if (at <= (toldChange.get(task) ?? -1)) continue;
      // A serve started again knows no change until the next, so a turn it first sees end began after the page opened.
      const before = toldChange.get(task) ?? opened;
      toldChange.set(task, at);
      const news = agentNews(task, s, seen);
      if (news.kind !== 'finished' && news.kind !== 'blocked') continue;
      // Nothing is told of the task being read: at its terminal it is seen as it happens; on another of its pages,
      // its Terminal row's dot says it.
      const where = lookingAt(task);
      if (where === 'terminal') setSeen((m) => markAgentSeen(m, task, at));
      if (where !== null) continue;
      // Words said since its last change, as the turn began, are this turn's, in already when the push beat herdr.
      const said = ix.tasks.find((t) => t.id === task)?.said;
      const words = said && said.at >= before ? said.text : undefined;
      if (said && words !== undefined) {
        // Told as they came, which said all this would.
        if (toldSaid.get(task) === saying(said)) continue;
        toldSaid.set(task, saying(said));
      }
      tell(task, news.kind, words, true);
    }
    for (const t of ix.tasks) {
      if (!t.said || toldSaid.get(t.id) === saying(t.said)) continue;
      toldSaid.set(t.id, saying(t.said));
      if (lookingAt(t.id) !== null) continue;
      const here = states[t.id];
      tell(t.id, here?.status === 'blocked' ? 'blocked' : 'said', t.said.text, here !== undefined && here.title === undefined);
    }
  });
  useEffect(() => {
    if (terminals && index && ready) look(terminals, index);
  }, [terminals, index, ready]);
}
