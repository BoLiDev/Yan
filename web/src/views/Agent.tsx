import { useRef, useState, type DragEvent } from 'react';
import type { TaskSummary } from '../lib/api';
import { dropped as dropTo, gapAt, moves } from '../lib/drag';
import { plural } from '../lib/format';
import { AGENT_TAB } from '../lib/route';
import { onAgentClick, openAgent, useAgentTab } from '../state/agentTab';
import { writeTask } from '../state/server';
import { Icon } from '../components/Icon';
import { Bar, Empty } from '../components/page';
import { useKeyNav, usePick } from './nav';
import { PickCard, PickList } from './PickCard';

/**
 * A task's agents running elsewhere, the last kept first: each with where
 * it is, the first picked; ↑ and ↓ pick another and Enter opens it in the
 * tab every agent opens in, as a click on any does. Several are dragged
 * into another order, kept in task.json, the first being the one going to
 * the task opens. The one the agent tab shows shimmers.
 */
export function AgentView({ t }: { t: TaskSummary }) {
  useKeyNav(null, null);
  const showing = useAgentTab((s) => s.showing);
  // The order dropped, shown until the index comes back with it.
  const [dropped, setDropped] = useState<{ was: string; names: string[] } | null>(null);
  // What is drawn of a drag: the card lifted, and the line where it would drop.
  const [drag, setDrag] = useState<{ from: number; gap: number } | null>(null);
  // The card lifted, for the drop to read as it comes, whether or not a redraw came between.
  const lifted = useRef<number | null>(null);
  const names = t.agents.map(([name]) => name);
  const order = dropped?.was === names.join('\n') ? dropped.names.flatMap((n) => t.agents.filter(([name]) => name === n)) : t.agents;
  const { at, pick, list } = usePick(order.length, (i) => {
    const [, where] = order[i] ?? [];
    if (where) openAgent(where);
  });
  if (!order.length) return <Empty title="No agent">{`${t.id} keeps no agent.`}</Empty>;

  // The gap a card dragged over card `i` drops into: above it from its upper half, below it from its lower.
  const gapOf = (i: number, e: DragEvent<HTMLDivElement>): number => {
    const box = e.currentTarget.getBoundingClientRect();
    return gapAt(i, e.clientY < box.top + box.height / 2);
  };
  const drop = (gap: number): void => {
    const from = lifted.current;
    lifted.current = null;
    setDrag(null);
    if (from === null || !moves(from, gap)) return;
    const to = dropTo(order.map(([name]) => name), from, gap);
    setDropped({ was: names.join('\n'), names: to });
    void writeTask('/api/agents', { task: t.id, order: to }, `${to[0] as string} is first now`);
  };
  // Where a card dragged would drop: a line above the card after the gap, or below the last.
  const lineAt = (i: number): 'above' | 'below' | undefined => {
    if (drag === null || !moves(drag.from, drag.gap)) return undefined;
    if (drag.gap === i) return 'above';
    return drag.gap === order.length && i === order.length - 1 ? 'below' : undefined;
  };
  return (
    <>
      <Bar title="Agent" meta={plural(order.length, 'agent')} />
      <PickList list={list}>
        {order.map(([name, where], i) => (
          <PickCard key={name} icon={<Icon name="cloud" size={20} />} name={name} where={where} picked={i === at} hint={i === at} shimmer={showing === where}
            href={where} target={AGENT_TAB} onClick={onAgentClick(where)} onPick={() => pick(i)} line={lineAt(i)} faint={drag?.from === i}
            drag={order.length > 1 ? {
              onDragStart: (e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', name);
                lifted.current = i;
                setDrag({ from: i, gap: i });
              },
              onDragOver: (e) => {
                if (lifted.current === null) return;
                e.preventDefault();
                const gap = gapOf(i, e);
                if (gap !== drag?.gap) setDrag({ from: lifted.current, gap });
              },
              onDrop: (e) => { e.preventDefault(); drop(gapOf(i, e)); },
              onDragEnd: () => { lifted.current = null; setDrag(null); },
            } : undefined} />
        ))}
      </PickList>
    </>
  );
}
