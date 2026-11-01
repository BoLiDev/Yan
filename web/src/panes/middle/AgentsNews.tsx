import type { Index } from '../../lib/api';
import { agentWords, allNews, type AgentNews } from '../../lib/agents';
import { ago } from '../../lib/format';
import { link } from '../../lib/route';
import type { Seen } from '../../lib/seen';
import { cn } from '../../lib/utils';
import { Icon } from '../../components/Icon';
import { ASIDE, Dot, GROW, WORKING, row } from '../../components/page';
import { useTerminals } from '../../state/server';

/** News first, what waits on `user` before what finished; then what is at work; then the rest, the latest first. */
function order(a: AgentNews, b: AgentNews): number {
  const rank = (n: AgentNews): number => (n.news ? (n.kind === 'blocked' ? 0 : 1) : n.kind === 'working' ? 2 : 3);
  return rank(a) - rank(b) || (b.at ?? 0) - (a.at ?? 0);
}

/**
 * What one task's agent is up to, and since when, a link to its terminal.
 * The words are the tooltip's: the row says it as the task list does, a
 * light over the title of one at work, an amber or green dot by one waiting
 * or finished, news in bold, and how long ago in a few characters.
 */
function AgentRow({ task, title, n }: { task: string; title: string; n: AgentNews }) {
  return (
    <a className={row()} href={link.terminal(task)} title={`${title} · ${agentWords(n)}`}>
      <Icon name="terminal" size={16} className="text-ink-3" />
      <span className={cn(GROW, n.news && 'font-bold', n.kind === 'working' && WORKING)}>{title}</span>
      {n.news ? <Dot title={agentWords(n)} tone={n.kind === 'blocked' ? 'blocked' : 'finished'} /> : null}
      {n.at === null ? null : <span className={ASIDE}>{ago(n.at)}</span>}
    </a>
  );
}

/**
 * Latest's Agents: a line for each task whose agent runs in herdr on this
 * machine, saying what it is up to and since when, as serve has watched it:
 * finished, waiting on `user`, at work. A click opens its terminal, and
 * typing there is looking at it.
 */
export function AgentsNews({ index, seen }: { index: Index; seen: Seen }) {
  const { data: terminals } = useTerminals();
  const rows = [...allNews(terminals, seen)].filter(([task]) => index.tasks.some((t) => t.id === task)).sort(([, a], [, b]) => order(a, b));
  if (!rows.length) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="px-2.5 py-1 text-[12.5px] font-bold text-ink-3">Agents</div>
      {rows.map(([task, n]) => <AgentRow key={task} task={task} title={index.tasks.find((t) => t.id === task)?.title || task} n={n} />)}
    </div>
  );
}
