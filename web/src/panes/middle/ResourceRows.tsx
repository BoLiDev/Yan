import { useState, type ReactNode } from 'react';
import type { TaskDetail, TaskSummary } from '../../lib/api';
import { KIND_WORD, isLink, listResources, type Listed as Resource } from '../../lib/resources';
import { Icon } from '../../components/Icon';
import { Editable, GROW } from '../../components/page';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import { writeTask } from '../../state/server';
import { ask, useUI } from '../../state/ui';
import { FoldRow, StepRow } from './FoldRow';
import { flip } from './folds';
import { GO, underRow } from './look';

/**
 * Where a resource points, as it is edited: whole, wrapping rather than
 * giving way, and framed while it has the keys, the frame fading in.
 */
const EDITING = cn(
  'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-normal wrap-anywhere text-[12.5px] text-ink-2',
  'rounded-[4px] outline-1 outline-dashed outline-transparent outline-offset-3 transition-[outline-color] duration-120',
  'focus:outline-[1.5px] focus:outline-solid focus:outline-brand',
);

/**
 * A resource under the Resources row: a web link is its name, opening in a
 * tab of its own; anything else is its name and its words. On hover, the
 * pencil edits where it points, keeping its kind, and the bin forgets it.
 */
function ResourceRow({ task, name, where, deep }: { task: string; name: string; where: string; deep: boolean }) {
  const [editing, setEditing] = useState(false);
  const url = isLink(where);
  const className = cn(underRow(false, deep), 'group/res gap-1.5');
  if (editing) {
    return (
      <div className={className}>
        <span className="flex-none">{name}</span>
        <Editable className={EDITING} text={where} autoFocus onSave={(to) => void writeTask('/api/resource', { task, name, where: to }, `Saved ${name}`)} onLeft={(changed) => { if (!changed) setEditing(false); }} />
      </div>
    );
  }
  return (
    <div className={className} title={where}>
      {url
        ? <a className={cn(GROW, 'text-inherit no-underline')} href={where.trim()} target="_blank" rel="noopener">{name}</a>
        : <><span className="flex-none">{name}</span><span className={cn(GROW, 'text-[12px] text-ink-3')}>{where}</span></>}
      <span className="-mx-0.5 -my-[5px] hidden flex-none group-hover/res:flex group-focus-within/res:flex">
        <Button variant="ghost" size="icon-xs" className="text-ink-3" title={`Edit ${name}`} aria-label={`Edit ${name}`} onClick={() => setEditing(true)}><Icon name="edit" size={14} /></Button>
        <Button variant="ghost" size="icon-xs" className="text-ink-3 hover:text-destructive" title={`Delete ${name}`} aria-label={`Delete ${name}`}
          onClick={() => ask({ title: `Delete the resource ${name}?`, sub: where, action: 'Delete', then: () => void writeTask('/api/resource', { task, name, remove: true }, `Deleted ${name}`) })}>
          <Icon name="trash" size={14} />
        </Button>
      </span>
      {url ? <span className={GO}><Icon name="external" size={14} /></span> : null}
    </div>
  );
}

/**
 * The Resources row under MR: what the task refers to, its agents aside,
 * folded until asked; under it a row for each kind, itself folded until
 * asked, so the row opens on the kinds there are, and under each its
 * resources, as MR has repositories and their branches. Resources of one
 * kind are straight under the row.
 */
export function ResourceRows({ t, d, on }: { t: TaskSummary; d: TaskDetail; on: boolean }) {
  const unfolded = useUI((s) => s.unfolded);
  const resources = listResources(t, d);
  if (!resources.length) return null;
  const groups = Object.keys(KIND_WORD).map((kind) => [kind, resources.filter((r) => r.kind === kind)] as const).filter(([, here]) => here.length);
  const fold = `${t.id}:res`;
  const open = unfolded[fold] ?? false;
  const rows = (here: readonly Resource[], deep: boolean): ReactNode[] => here.map((r) => <ResourceRow key={r.name} task={t.id} name={r.name} where={r.where} deep={deep} />);
  return (
    <>
      <FoldRow icon="link" word="Resources" aside={resources.length} open={open} on={on} onFlip={() => flip(fold, open)} />
      {open && groups.length === 1 ? rows((groups[0] as (typeof groups)[number])[1], false) : null}
      {open && groups.length > 1 ? groups.flatMap(([kind, here]) => {
        const key = `${t.id}:res:${kind}`;
        const shown = unfolded[key] ?? false;
        return [
          <StepRow key={key} name={KIND_WORD[kind]} aside={here.length} open={shown} onFlip={() => flip(key, shown)} />,
          ...(shown ? rows(here, true) : []),
        ];
      }) : null}
    </>
  );
}
