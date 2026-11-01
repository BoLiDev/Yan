import type { ReactNode } from 'react';
import type { Index, TaskSummary } from '../../lib/api';
import { agentNews, agentWords } from '../../lib/agents';
import { link, type TaskRoute } from '../../lib/route';
import { logFresh, unseenOf, type Seen } from '../../lib/seen';
import { goesOn } from '../../lib/stops';
import { Icon, StateIcon, type IconName } from '../../components/Icon';
import { ASIDE, Dot, GROW, Pane, row } from '../../components/page';
import { useTask, useTerminals } from '../../state/server';
import { AgentRows } from './AgentRows';
import { useArtifactsPart } from './ArtifactsPart';
import { useBranchPart } from './BranchPart';
import { MrRows } from './MrRows';
import { ResourceRows } from './ResourceRows';
import { TaskHead } from './TaskHead';
import { NAV, navRow } from './look';

/** A row of the nav that opens a page of the task: its icon, its word, and what is beside it. */
function NavLink({ href, on, icon, word, title, children }: { href: string; on: boolean; icon: IconName; word: string; title?: string; children?: ReactNode }) {
  return (
    <a className={navRow(on)} aria-current={on ? 'page' : undefined} href={href} title={title}>
      <Icon name={icon} size={16} /><span className={GROW}>{word}</span>{children}
    </a>
  );
}

/** A task's column: its title, its nav, and its artifacts or the branch being looked at. */
export function TaskIndex({ t, r, index, seen }: { t: TaskSummary; r: TaskRoute; index: Index; seen: Seen }) {
  const { data: d } = useTask(t.id);
  const terminal = useTerminals().data?.[t.id];
  const agent = terminal === undefined ? undefined : agentNews(t.id, terminal, seen);
  const unseen = unseenOf(index, seen, t.id);
  const logCount = d?.log?.entries.length ?? 0;
  // Against what was last read, not what this visit started from: reading the log clears it.
  const fresh = !!d?.log && logFresh(seen, t.id, logCount);
  const artifacts = useArtifactsPart(t, d, r, index, seen);
  // Asked for on every route so the hooks run in the same order; off a branch, it reads none.
  const branch = useBranchPart(t, r.sub === 'branch' ? r : { view: 'task', id: t.id, sub: 'branch', repo: -1, name: null, tab: 'changes', item: '' });
  // An open branch takes the part that scrolls, and the artifacts wait at the foot.
  const part = r.sub === 'branch' ? branch : artifacts;
  const top = (
    <>
      <TaskHead icon={<StateIcon state={t.state} size={18} />} title={t.title || t.id} />
      <div className={NAV}>
        {/* Overview and Log say nothing beside their names: what is in them is a click away. */}
        <NavLink href={link.task(t.id)} on={r.sub === 'overview'} icon="overview" word="Overview" />
        {d?.files.some((f) => f.path === 'report.html') ? (
          <NavLink href={link.report(t.id)} on={r.sub === 'report'} icon="check" word="Report">
            {unseen.has('report.html') ? <Dot title="changed since your last look" /> : null}
            <span className={ASIDE}>report.html</span>
          </NavLink>
        ) : null}
        <NavLink href={link.log(t.id)} on={r.sub === 'log'} icon="log" word="Log">
          {fresh ? <Dot title="new entries" /> : null}
        </NavLink>
        {/* An open task keeps its Terminal row with no agent running, where it is started again. Its agent has the
            dot it has everywhere else while it waits or has finished unseen; that it is at work, the task's title says. */}
        {terminal || goesOn(t) ? (
          <NavLink href={link.terminal(t.id)} on={r.sub === 'terminal'} icon="terminal" word="Terminal" title={agent ? agentWords(agent) : undefined}>
            {agent?.news ? <Dot title={agentWords(agent)} tone={agent.kind === 'blocked' ? 'blocked' : 'finished'} /> : null}
          </NavLink>
        ) : null}
        {t.agents.length ? <AgentRows t={t} agents={t.agents} on={r.sub === 'agent'} /> : null}
        {t.repos.some((repo) => repo.branch) ? <MrRows t={t} r={r} ready={!!d} /> : null}
        {d ? <ResourceRows t={t} d={d} on={r.sub === 'resources'} /> : null}
      </div>
      {part.top}
    </>
  );
  const foot = r.sub === 'branch' && d ? (
    <a className={row()} href={link.folder(t.id, '')}>
      <Icon name="folder" size={15} className="flex-none text-ink-3" /><span className={GROW}>Artifacts</span>
    </a>
  ) : null;
  return <Pane remember={t.id} top={top} body={part.body} foot={foot} />;
}
