import { useState, type ReactNode } from 'react';
import type { TaskSummary } from '../../lib/api';
import { dropped as dropTo, gapAt, moves } from '../../lib/drag';
import { AGENT_TAB } from '../../lib/route';
import { Icon } from '../../components/Icon';
import { ASIDE, GROW, SHIMMER } from '../../components/page';
import { cn } from '../../lib/utils';
import { onAgentClick, useAgentTab } from '../../state/agentTab';
import { writeTask } from '../../state/server';
import { useUI } from '../../state/ui';
import { FoldRow } from './FoldRow';
import { flip } from './folds';
import { GO, WORD, navRow, underRow } from './look';

/**
 * An Agent row under Log: one agent opens from it; several fold under it,
 * as a repository's branches do, newest first, and are dragged to another
 * order, the first being the one going to the task opens. While this page
 * holds the agent tab, what it shows there shimmers: the agent, or the word
 * Agent while they are folded.
 */
export function AgentRows({ t, agents, on }: { t: TaskSummary; agents: readonly (readonly [string, string])[]; on: boolean }) {
  const fold = `${t.id}:agents`;
  const unfolded = useUI((s) => s.unfolded[fold]) ?? false;
  const showing = useAgentTab((s) => s.showing);
  // The order dropped, shown until the index comes back with it.
  const [dropped, setDropped] = useState<{ was: string; names: string[] } | null>(null);
  const [drag, setDrag] = useState<{ from: number; gap: number } | null>(null);
  const names = agents.map(([name]) => name);
  const order = dropped?.was === names.join('\n') ? dropped.names.flatMap((n) => agents.filter(([name]) => name === n)) : agents;
  const go = <span className={GO}><Icon name="external" size={14} /></span>;
  if (order.length === 1) {
    const [name, where] = order[0] as readonly [string, string];
    // The agent is named beside the word, giving way first.
    return (
      <a className={navRow(on)} aria-current={on ? 'page' : undefined} href={where} target={AGENT_TAB} title={`${name}: ${where}`} onClick={onAgentClick(where)}>
        <Icon name="cloud" size={16} /><span className={WORD}>Agent</span><span className={GROW} />
        <span className={cn(ASIDE, 'min-w-[2ch] flex-initial truncate', showing === where && SHIMMER)}>{name}</span>{go}
      </a>
    );
  }
  const drop = (): void => {
    if (drag === null || !moves(drag.from, drag.gap)) return setDrag(null);
    const to = dropTo(order.map(([name]) => name), drag.from, drag.gap);
    setDropped({ was: names.join('\n'), names: to });
    setDrag(null);
    void writeTask('/api/agents', { task: t.id, order: to }, `${to[0] as string} is first now`);
  };
  // Where one would drop is a line, which takes no room.
  const line = (gap: number): ReactNode => (drag !== null && drag.gap === gap && moves(drag.from, gap)
    ? <div key={`gap${gap}`} className="pointer-events-none mx-2 -mt-0.5 -mb-px h-0.5 flex-none rounded-[2px] bg-brand" /> : null);
  return (
    <>
      <FoldRow icon="cloud" word="Agent" aside={order.length} open={unfolded} on={on} shine={!unfolded && order.some(([, where]) => where === showing)} onFlip={() => flip(fold, unfolded)} />
      {unfolded ? order.flatMap(([name, where], i) => [
        line(i),
        // Agents are dragged by their row, the grip in the indent showing it can be.
        <a key={name} className={cn(underRow(false, false), 'group/agent relative', drag?.from === i && 'opacity-45')} href={where} target={AGENT_TAB} title={where} draggable
          onClick={onAgentClick(where)}
          onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', name); setDrag({ from: i, gap: i }); }}
          onDragOver={(e) => {
            if (drag === null) return;
            e.preventDefault();
            const box = e.currentTarget.getBoundingClientRect();
            const gap = gapAt(i, e.clientY < box.top + box.height / 2);
            if (gap !== drag.gap) setDrag({ ...drag, gap });
          }}
          onDrop={(e) => { e.preventDefault(); drop(); }}
          onDragEnd={() => setDrag(null)}>
          <span className="absolute top-1/2 left-3.5 flex -translate-y-1/2 text-ink-3 opacity-0 group-hover/agent:opacity-100"><Icon name="grip" size={14} width={2.6} /></span>
          <span className={cn(GROW, showing === where && SHIMMER)}>{name}</span>{go}
        </a>,
        i === order.length - 1 ? line(i + 1) : null,
      ]) : null}
    </>
  );
}
