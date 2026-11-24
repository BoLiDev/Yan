import type { TaskDetail, TaskSummary } from '../lib/api';
import { when } from '../lib/format';
import { Bar, Empty, Paper, Scroll } from '../components/page';
import { MarkdownDoc } from './Markdown';
import { useKeyNav } from './nav';

/**
 * A task's principles: what `user` holds all of it to, as principles.md
 * has them. Read here, never written: one is recorded by asking the task's
 * agent, with yan:principle, which is said where there are none.
 */
export function PrinciplesView({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  useKeyNav(null, null);
  if (d.principles === null) return <Empty title="No principles">{`${t.id} is held to none yet. Record one by running /yan:principle in its agent, with what it is.`}</Empty>;
  return (
    <>
      <Bar title="Principles" meta={d.principles.changed ? `changed ${when(d.principles.changed)}` : undefined} />
      <Scroll><Paper><MarkdownDoc text={d.principles.text} task={t.id} dir="" /></Paper></Scroll>
    </>
  );
}
