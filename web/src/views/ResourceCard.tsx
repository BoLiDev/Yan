import { useState } from 'react';
import { isLink, type Listed } from '../lib/resources';
import { Icon } from '../components/Icon';
import { Editable } from '../components/page';
import { Button } from '../components/ui/button';
import { writeTask } from '../state/server';
import { ask } from '../state/ui';
import { PickCard } from './PickCard';

/** Where a resource points, as it is edited: whole, wrapping rather than giving way, and framed as any text edited where it stands is. */
const EDITING = 'min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-normal wrap-anywhere text-[12.5px] text-ink-2';

/**
 * A resource's card: a web link opens in a tab of its own, anything else is
 * its name over its words. On hover, the pencil edits where it points,
 * keeping its kind, and the bin forgets it, once asked.
 */
export function ResourceCard({ task, r, picked, onPick }: { task: string; r: Listed; picked: boolean; onPick: () => void }) {
  const [editing, setEditing] = useState(false);
  const url = isLink(r.where);
  const tools = (
    <>
      <Button variant="ghost" size="icon-xs" className="text-ink-3" title={`Edit ${r.name}`} aria-label={`Edit ${r.name}`} onClick={() => setEditing(true)}><Icon name="edit" size={14} /></Button>
      <Button variant="ghost" size="icon-xs" className="text-ink-3 hover:text-destructive" title={`Delete ${r.name}`} aria-label={`Delete ${r.name}`}
        onClick={() => ask({ title: `Delete the resource ${r.name}?`, sub: r.where, action: 'Delete', then: () => void writeTask('/api/resource', { task, name: r.name, remove: true }, `Deleted ${r.name}`) })}>
        <Icon name="trash" size={14} />
      </Button>
    </>
  );
  const edit = editing ? (
    <span className="relative z-10 flex min-w-0 flex-auto flex-col gap-0.5">
      <b className="truncate">{r.name}</b>
      <Editable className={EDITING} text={r.where} autoFocus onSave={(to) => writeTask('/api/resource', { task, name: r.name, where: to }, `Saved ${r.name}`)}
        onLeft={(changed) => { if (!changed) setEditing(false); }} />
    </span>
  ) : undefined;
  return (
    <PickCard icon={<Icon name={url ? 'link' : 'note'} size={18} />} name={r.name} where={r.where} picked={picked} hint={url && picked} onPick={onPick}
      tools={tools} editing={edit} href={url ? r.where.trim() : undefined} target="_blank" rel="noopener" />
  );
}
