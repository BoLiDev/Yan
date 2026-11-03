import { useState } from 'react';
import type { Draft } from '../../lib/api';
import { when } from '../../lib/format';
import { cn } from '../../lib/utils';
import { useDrafts } from '../../state/server';
import { useUI } from '../../state/ui';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Spinner } from '../ui/spinner';
import { DraftPage } from './DraftPage';
import { NEW } from './save';

const NONE: readonly Draft[] = [];

/** A draft's line in the list: its title, and when it was last edited. */
function Row({ title, meta, on, onPick }: { title: string; meta: string; on: boolean; onPick: () => void }) {
  return (
    <button type="button" aria-current={on || undefined} onClick={onPick}
      className={cn('flex w-full cursor-pointer flex-col items-start rounded-[10px] px-3 py-2 text-left', on ? 'bg-card ring-1 ring-border' : 'hover:bg-hover')}>
      <span className="w-full truncate text-[13.5px] font-medium text-foreground">{title}</span>
      <span className="w-full truncate text-[12px] text-ink-3">{meta}</span>
    </button>
  );
}

/**
 * The drafts, in their box: the list down the side, newest first, with New
 * above it, and the one picked beside it, read and written in one place.
 * The newest is shown first; with none at all, a new one, ready to write.
 * One whose saving failed is shown again, being written.
 */
function DraftsBox() {
  const drafts = useDrafts();
  const list = drafts.data ?? NONE;
  const kept = useUI((s) => s.draftKept);
  // A save that failed after its draft was left takes it up again, over whatever is shown; one whose draft is gone meanwhile, as a new one.
  const keptAt = kept === null ? null : kept.id !== null && (!drafts.isSuccess || list.some((d) => d.id === kept.id)) ? kept.id : NEW;
  const [picked, setPicked] = useState<string | null>(keptAt);
  if (keptAt !== null && picked !== keptAt) setPicked(keptAt);
  // The one picked, while it is there; then the newest, or a new one when there are none.
  const shown = picked === NEW || list.some((d) => d.id === picked) ? (picked as string) : drafts.isSuccess ? list[0]?.id ?? NEW : null;
  const draft = list.find((d) => d.id === shown);
  const onSaved = (id: string | null): void => setPicked((p) => (p === NEW ? id : p === shown && id === null ? null : p));
  return (
    <>
      <aside className="flex min-h-0 flex-col gap-2 border-r border-sunken bg-sunken p-3" aria-label="Drafts">
        <div className="flex items-center gap-2 py-1 pr-0.5 pl-2">
          <DialogTitle className="flex-1 text-[17px] font-bold">Drafts</DialogTitle>
          <Button variant="secondary" size="sm" onClick={() => setPicked(NEW)}><Icon name="plus" size={14} />New</Button>
        </div>
        <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1">
          {shown === NEW ? <Row title="New draft" meta="not saved yet" on onPick={() => undefined} /> : null}
          {list.map((d) => (
            <Row key={d.id} title={d.title} meta={`${when(d.changed)}${d.task ? ` · ${d.task}` : ''}`} on={d.id === shown} onPick={() => setPicked(d.id)} />
          ))}
          {drafts.isSuccess && list.length === 0 && shown !== NEW ? <span className="px-2 text-[13px] text-ink-3">No drafts yet.</span> : null}
          {drafts.isError ? <span className="px-2 text-[13px] text-destructive">Could not read the drafts: {drafts.error.message}</span> : null}
        </div>
      </aside>
      {shown === null ? (
        <div className="flex items-center justify-center"><Spinner /></div>
      ) : (
        <DraftPage key={shown} draft={draft} fresh={shown === NEW} kept={keptAt === shown ? kept : null} onSaved={onSaved} />
      )}
    </>
  );
}

/**
 * The drafts' box over the page, opened from the task list. Escape while a
 * draft is being written only stops writing it, which saves it; again, it
 * closes the box.
 */
export function DraftsModal() {
  const open = useUI((s) => s.drafts);
  return (
    <Dialog open={open} onOpenChange={(next, details) => {
      const active = document.activeElement;
      if (!next && details.reason === 'escape-key' && active instanceof HTMLTextAreaElement && active.hasAttribute('data-draft')) {
        details.cancel();
        active.blur();
        return;
      }
      useUI.setState({ drafts: next });
    }}>
      <DialogContent showCloseButton={false} className="grid h-[min(820px,calc(100vh-4rem))] w-[min(1160px,calc(100vw-3rem))] max-w-none grid-cols-[272px_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-none">
        {open ? <DraftsBox /> : null}
      </DialogContent>
    </Dialog>
  );
}
