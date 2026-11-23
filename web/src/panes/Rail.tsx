import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { JANUS, works, type TaskSummary } from '../lib/api';
import { agentWords, allNews, type AgentNews } from '../lib/agents';
import { MOD } from '../lib/format';
import { link, useRoute } from '../lib/route';
import { cn } from '../lib/utils';
import { Icon, StateIcon, type IconName } from '../components/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { TaskMenu } from '../components/TaskMenu';
import { goesOn } from '../lib/stops';
import { dropAllBubbles, dropBubble, useBubbles } from '../state/bubbles';
import { useIndex, useTerminals } from '../state/server';
import { setPref, useUI } from '../state/ui';
import { RailBubbles } from './RailBubble';

/** The corner mark of a task's agent: amber while it waits on `user`, green once it has finished and nobody has looked. */
function Mark({ news }: { news: AgentNews | undefined }) {
  if (!news?.news) return null;
  return <span className={cn('absolute -top-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-sunken', news.kind === 'blocked' ? 'bg-warning' : 'bg-success')} />;
}

const SQUARE = 'relative flex size-9 flex-none cursor-pointer items-center justify-center rounded-[10px] text-ink-3 hover:bg-hover hover:text-foreground';

function Tip({ label, children }: { label: string; children: React.ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function RailButton({ icon, label, onClick, href, on, mark, faint, busy }: { icon: IconName; label: string; onClick?: () => void; href?: string; on?: boolean; mark?: ReactNode; faint?: boolean; busy?: boolean }) {
  const look = cn(SQUARE, on && 'bg-card text-foreground ring-1 ring-border hover:bg-card', faint && '[&>svg]:opacity-40', busy && '[&>svg]:animate-pulse [&>svg]:text-brand motion-reduce:[&>svg]:animate-none');
  const inner = <><Icon name={icon} size={17} />{mark}</>;
  return (
    <Tip label={label}>
      {href ? <a className={look} href={href} aria-label={label} aria-current={on ? 'page' : undefined}>{inner}</a>
        : <button type="button" className={look} aria-label={label} onClick={onClick}>{inner}</button>}
    </Tip>
  );
}

function TaskSquare({ t, news, on, squares }: { t: TaskSummary; news: AgentNews | undefined; on: boolean; squares: RefObject<Map<string, HTMLElement>> }) {
  const last = useUI((s) => s.last[t.id]);
  // Opened above the square while it and the one above it speak, so the two bubbles stand level with their squares.
  const room = useBubbles((s) => s.room[t.id] ?? 0);
  const speaking = useBubbles((s) => { const b = s.bubbles[t.id]; return b === undefined ? undefined : `${b.n}.${b.v}`; });
  const name = t.title || t.id;
  const label = news ? `${name} · ${agentWords(news)}` : name;
  const working = news?.kind === 'working';
  // What the task's agent says is no news on the task itself, which the page shows; and it goes with the square.
  useEffect(() => {
    if (on) dropBubble(t.id);
  }, [on, t.id]);
  useEffect(() => () => dropBubble(t.id), [t.id]);
  // The square is the tooltip's trigger and the task's menu's at once; while it speaks, its bubble says more than the tooltip would.
  const square = <a ref={(el) => { if (el === null) squares.current.delete(t.id); else squares.current.set(t.id, el); }} style={room > 0 ? { marginTop: room } : undefined} className={cn(SQUARE, on && 'bg-card text-foreground ring-1 ring-border hover:bg-card')}
    href={last ?? link.task(t.id)} aria-label={label} aria-current={on ? 'page' : undefined} />;
  return (
    <>
      <Tooltip disabled={speaking !== undefined}>
        <TaskMenu t={t} render={<TooltipTrigger render={square} />}>
          {/* Hops each time it says something. */}
          <span key={speaking ?? ''} className={cn('inline-block', speaking !== undefined && 'animate-hop')}>
            {/* The mark of where the task stands, as on the list: which task it is, the tooltip says. It breathes while the agent is at work. */}
            <span className={cn('block', working && 'animate-pulse motion-reduce:animate-none')}><StateIcon t={t} size={18} /></span>
          </span>
          <Mark news={news} />
        </TaskMenu>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </>
  );
}

/**
 * The task list folded to a rail: its tools as icons, and a square for each
 * task in review or in progress, drawn as the mark of where it stands, a
 * blue half circle in progress and an amber dot in a ring in review, named
 * by its tooltip, the one being read framed, so any of them is a click away, and what each
 * one's agent is up to shows at a glance: the mark of one at work
 * breathing, a mark at the corner of one waiting or finished, and a bubble
 * from one whose agent has something to say, which stands first on the rail
 * while it speaks.
 */
export function Rail() {
  const { data: index } = useIndex();
  const seen = useUI((s) => s.seen);
  const { data: terminals } = useTerminals();
  const r = useRoute();
  const news = allNews(terminals, seen);
  const byTouched = (a: TaskSummary, b: TaskSummary): number => b.touched - a.touched;
  // In review, then in progress; a paused task is put aside, and the rail is for what is being worked on. Those whose squares
  // speak stand first, in the order they began, while any does: one goes there as its bubble pops, and stays.
  const pinned = useBubbles((s) => s.pinned);
  const usual = index ? [
    ...works(index.tasks).filter((t) => t.state === 'uat' && goesOn(t)).sort(byTouched),
    ...works(index.tasks).filter((t) => t.state !== 'uat' && goesOn(t)).sort(byTouched),
  ] : [];
  const tasks = [...pinned.flatMap((id) => usual.filter((t) => t.id === id)), ...usual.filter((t) => !pinned.includes(t.id))];
  // What the squares were saying goes with them, and is told in toasts while the list is shown.
  useEffect(() => dropAllBubbles, []);
  const squares = useRef(new Map<string, HTMLElement>());
  return (
    <nav className="flex h-screen w-14 flex-none flex-col items-center gap-1 overflow-y-auto bg-sunken py-3.5" aria-label="Tasks">
      <RailButton icon="panel" label="Show the task list" onClick={() => setPref('left', true)} />
      <RailButton icon="search" label={`Find a task (${MOD}K)`} onClick={() => useUI.setState({ palette: true })} />
      <RailButton icon="plus" label="New task" onClick={() => useUI.setState({ newTask: true })} />
      {/* What the list's head opens is opened from here too: neither box is a task's, and folding the list is no reason to lose them. */}
      <RailButton icon="janus" label={terminals?.[JANUS] === undefined ? 'Janus, not started' : 'Janus'} href={link.terminal(JANUS)} on={r.view === 'task' && r.id === JANUS} faint={terminals?.[JANUS] === undefined} busy={terminals?.[JANUS]?.status === 'working'} />
      <RailButton icon="note" label="Drafts" onClick={() => useUI.setState({ drafts: true })} />
      <RailButton icon="settings" label="Settings" onClick={() => useUI.setState({ settings: true })} />
      <span className="my-2 h-px w-7 flex-none bg-border" />
      {tasks.map((t) => <TaskSquare key={t.id} t={t} news={news.get(t.id)} on={r.view === 'task' && r.id === t.id} squares={squares} />)}
      <RailBubbles squares={squares} />
    </nav>
  );
}
