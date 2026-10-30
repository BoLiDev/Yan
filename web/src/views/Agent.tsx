import type { TaskSummary } from '../lib/api';
import { AGENT_TAB } from '../lib/route';
import { Icon } from '../components/Icon';
import { Bar, Empty } from '../components/ui';
import { useKeyNav } from './nav';

/**
 * A task's agents running elsewhere, as Tab comes to them: each with where
 * it is, opened in the tab every agent opens in by a click, or the first by
 * Enter. A stop of their own, so Tab can pass them by without leaving the
 * page for the agent's tab.
 */
export function AgentView({ t }: { t: TaskSummary }) {
  useKeyNav(null, null);
  if (!t.agents.length) return <Empty title="No agent">{`${t.id} keeps no agent.`}</Empty>;
  return (
    <>
      <Bar title="Agent" meta={t.agents.length === 1 ? 'Enter opens it, in the tab every agent opens in' : `${t.agents.length} agents · Enter opens the first, in the tab every agent opens in`} />
      <div className="scroll">
        <div className="agent-page">
          {t.agents.map(([name, where], i) => (
            <a key={name} className="agent-card" href={where} target={AGENT_TAB} title={where}>
              <Icon name="cloud" size={20} />
              <span className="grow"><b>{name}</b><span className="where">{where}</span></span>
              <span className="button">打开{i === 0 ? <kbd>↵</kbd> : null}</span>
            </a>
          ))}
        </div>
      </div>
    </>
  );
}
