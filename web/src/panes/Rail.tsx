import type { ReactNode } from 'react';
import { stateOf, type TaskSummary } from '../lib/api';
import { agentWords, allNews, tasksWithNews, type AgentNews } from '../lib/agents';
import { MOD } from '../lib/format';
import { initialsOf } from '../lib/letters';
import { link, useRoute } from '../lib/route';
import { cn } from '../lib/utils';
import { Icon, type IconName } from '../components/Icon';
import { WORKING } from '../components/page';
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip';
import { useIndex, useTerminals } from '../state/server';
import { setPref, useUI } from '../state/ui';

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

function RailButton({ icon, label, onClick, href, on, mark }: { icon: IconName; label: string; onClick?: () => void; href?: string; on?: boolean; mark?: ReactNode }) {
  const look = cn(SQUARE, on && 'bg-card text-foreground ring-1 ring-border hover:bg-card');
  const inner = <><Icon name={icon} size={17} />{mark}</>;
  return (
    <Tip label={label}>
      {href ? <a className={look} href={href} aria-label={label} aria-current={on ? 'page' : undefined}>{inner}</a>
        : <button type="button" className={look} aria-label={label} onClick={onClick}>{inner}</button>}
    </Tip>
  );
}

function TaskSquare({ t, letters, news, on }: { t: TaskSummary; letters: string; news: AgentNews | undefined; on: boolean }) {
  const last = useUI((s) => s.last[t.id]);
  const name = t.title || t.id;
  const label = news ? `${name} · ${agentWords(news)}` : name;
  const working = news?.kind === 'working';
  return (
    <Tip label={label}>
      <a className={cn(SQUARE, 'text-[12.5px] font-bold tracking-tight text-ink-2', on && 'bg-card text-foreground ring-1 ring-border hover:bg-card')}
        href={last ?? link.task(t.id)} aria-label={label} aria-current={on ? 'page' : undefined}>
        <span className={cn(working && WORKING)}>{letters}</span>
        <Mark news={news} />
      </a>
    </Tip>
  );
}

/**
 * The task list folded to a rail: its tools as icons, and a square for each
 * task in review or in progress, told apart by its title's letters, the one
 * being read framed, so any of them is a click away, and what each one's
 * agent is up to shows at a glance: a light over the letters of one at
 * work, a mark at the corner of one waiting or finished.
 */
export function Rail() {
  const { data: index } = useIndex();
  const seen = useUI((s) => s.seen);
  const { data: terminals } = useTerminals();
  const r = useRoute();
  const news = allNews(terminals, seen);
  const fresh = index && seen ? tasksWithNews(index, seen, news) : 0;
  const byTouched = (a: TaskSummary, b: TaskSummary): number => b.touched - a.touched;
  const tasks = index ? [
    ...index.tasks.filter((t) => t.state === 'uat').sort(byTouched),
    ...index.tasks.filter((t) => t.state !== 'uat' && stateOf(t.state) === 'open').sort(byTouched),
  ] : [];
  const letters = initialsOf(tasks);
  return (
    <nav className="flex h-screen w-14 flex-none flex-col items-center gap-1 overflow-y-auto bg-sunken py-3.5" aria-label="Tasks">
      <RailButton icon="panel" label="Show the task list" onClick={() => setPref('left', true)} />
      <RailButton icon="search" label={`Find a task (${MOD}K)`} onClick={() => useUI.setState({ palette: true })} />
      <RailButton icon="plus" label="New task" onClick={() => useUI.setState({ newTask: true })} />
      <RailButton icon="latest" label="Latest" href="#/latest" on={r.view === 'latest'}
        mark={fresh > 0 ? <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-brand ring-2 ring-sunken" /> : null} />
      <span className="my-2 h-px w-7 flex-none bg-border" />
      {tasks.map((t) => <TaskSquare key={t.id} t={t} letters={letters.get(t.id) ?? ''} news={news.get(t.id)} on={r.view === 'task' && r.id === t.id} />)}
    </nav>
  );
}
