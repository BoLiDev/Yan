import type { TaskSummary } from '../lib/api';
import { plural } from '../lib/format';
import { AGENT_TAB } from '../lib/route';
import { onAgentClick, openAgent, useAgentTab } from '../state/agentTab';
import { Icon } from '../components/Icon';
import { Bar, Empty } from '../components/ui';
import { Kbd } from '../components/ui/kbd';
import { useKeyNav, usePick } from './nav';

/**
 * A task's agents running elsewhere, as Tab comes to them: each with where
 * it is, the first picked; ↑ and ↓ pick another and Enter opens it in the
 * tab every agent opens in, as a click on any does. A stop of their own, so
 * Tab can pass them by without leaving the page for the agent's tab.
 */
export function AgentView({ t }: { t: TaskSummary }) {
  useKeyNav(null, null);
  const showing = useAgentTab((s) => s.showing);
  const { at, pick, list } = usePick(t.agents.length, (i) => {
    const [, where] = t.agents[i] ?? [];
    if (where) openAgent(where);
  });
  if (!t.agents.length) return <Empty title="No agent">{`${t.id} keeps no agent.`}</Empty>;
  return (
    <>
      <Bar title="Agent" meta={plural(t.agents.length, 'agent')} />
      <div className="scroll">
        <div className="agent-page" ref={list}>
          {t.agents.map(([name, where], i) => (
            <a key={name} className={'agent-card' + (i === at ? ' picked' : '')} aria-selected={i === at} href={where} target={AGENT_TAB} title={where} onClick={onAgentClick(where)} onMouseMove={() => pick(i)}>
              <Icon name="cloud" size={20} />
              <span className="grow"><b className={showing === where ? 'shimmer' : undefined}>{name}</b><span className="where">{where}</span></span>
              {i === at ? <span className="flex flex-none items-center gap-1.5 text-xs text-muted-foreground">Open<Kbd>↵</Kbd></span> : null}
            </a>
          ))}
        </div>
      </div>
    </>
  );
}
