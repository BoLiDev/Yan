import { statusOf, type DeliverableStatus, type TaskDetail, type TaskSummary } from '../../lib/api';
import { Icon } from '../../components/Icon';
import { Editable } from '../../components/page';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import { writeTask } from '../../state/server';
import { ask } from '../../state/ui';
import { Section } from './Section';

/** Where each deliverable stands, as its mark on the rail: a box to do, filled once done, a dash once given up. */
const NODE: Readonly<Record<DeliverableStatus, string>> = {
  todo: 'mt-1.5 size-2.5 rounded-[3px] bg-card shadow-[inset_0_0_0_1.75px_var(--ink-4)]',
  done: 'mt-1.5 size-2.5 rounded-[3px] bg-brand',
  abandoned: 'mt-2.5 h-0.5 w-2.5 rounded-[1px] bg-ink-4',
};
/** A deliverable's own tools, seen while it is under the pointer or one of them has the keyboard. */
const DELIV_TOOL = 'size-[22px] text-ink-3 opacity-0 group-hover/deliv:opacity-100 focus-visible:opacity-100';

/**
 * A task's deliverables on a rail, each joined to the next. A text clicked
 * is edited; one given up keeps its reason on its line, and one deleted with
 * the bin goes as if never added, the ones after it taking its number.
 */
export function Deliverables({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  const ds = d.deliverables;
  const n = (s: string): number => ds.filter((x) => x.status === s).length;
  const counts = [n('done') ? `${n('done')} done` : null, n('todo') ? `${n('todo')} to do` : null, n('abandoned') ? `${n('abandoned')} dropped` : null].filter(Boolean).join(' · ');
  return (
    <Section title="Deliverables" meta={counts}>
      <div className="flex flex-col">
        {ds.map((x) => {
          const status = statusOf(x.status);
          return (
            // The rail runs from under one mark to the next; the last has none.
            <div key={x.id} className="group/deliv relative grid grid-cols-[10px_minmax(0,1fr)_auto] gap-x-4 pb-5 text-[14.5px] leading-[22px] before:absolute before:top-5 before:-bottom-0.5 before:left-1 before:w-0.5 before:rounded-[1px] before:bg-border last:before:hidden">
              <span className={NODE[status]} title={x.status} />
              <span>
                <span className={status === 'abandoned' ? 'text-ink-3' : undefined}>
                  <span className="mr-2 font-mono text-[12px] leading-normal text-ink-3">{x.id}</span>
                  <Editable text={x.text} onSave={(text) => void writeTask('/api/deliverable/text', { task: t.id, id: x.id, text }, `Saved ${x.id}`)} />
                </span>
                {x.reason ? <Editable className="block w-fit max-w-full text-[13px] leading-5 text-ink-3" text={x.reason} onSave={(reason) => void writeTask('/api/deliverable', { task: t.id, id: x.id, to: 'abandoned', reason }, `Saved why ${x.id} was given up`)} /> : null}
              </span>
              {/* The date, and under it, a gap away, giving up and the bin that show on hover: laid over the row, so a row of one line keeps its height. */}
              <span className="relative flex justify-end">
                <span className="min-h-[22px] text-[13px] whitespace-nowrap text-ink-3 tabular-nums">{x.doneAt ? x.doneAt.slice(5).replace('-', '.') : ''}</span>
                <span className="absolute top-6 -right-[5px] z-[1] flex gap-0.5">
                  {x.status === 'abandoned' ? null : (
                    <Button variant="ghost" size="icon-xs" className={DELIV_TOOL} title={`Give up ${x.id}`} aria-label={`Give up ${x.id}`}
                      onClick={() => ask({ title: `Give up ${x.id}?`, sub: x.text, action: 'Give up', reason: 'Why, in a line: it stays under the deliverable',
                        then: (reason) => void writeTask('/api/deliverable', { task: t.id, id: x.id, to: 'abandoned', reason }, `Gave up ${x.id}`) })}>
                      <Icon name="ban" size={15} />
                    </Button>
                  )}
                  <Button variant="ghost" size="icon-xs" className={cn(DELIV_TOOL, 'hover:text-destructive')} title={`Delete ${x.id}`} aria-label={`Delete ${x.id}`}
                    onClick={() => ask({ title: `Delete ${x.id}?`, sub: x.text, action: 'Delete', then: () => void writeTask('/api/deliverable/remove', { task: t.id, id: x.id }, `Deleted ${x.id}`) })}>
                    <Icon name="trash" size={15} />
                  </Button>
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
