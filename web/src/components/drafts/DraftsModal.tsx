import { useState, type ReactNode } from 'react';
import type { Draft } from '../../lib/api';
import { when } from '../../lib/format';
import { cn } from '../../lib/utils';
import { useDrafts } from '../../state/server';
import { useUI } from '../../state/ui';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../ui/alert-dialog';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '../ui/context-menu';
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog';
import { Spinner } from '../ui/spinner';
import { DraftPage } from './DraftPage';
import { NEW, deleteDraft, pushDrafts } from './save';

const NONE: readonly Draft[] = [];

/**
 * A draft's line in the list: its title, and when it was last edited. A
 * right click on one saved opens its own menu in place of the browser's,
 * which deletes it, once asked.
 */
function Row({ title, meta, on, onPick, onDelete }: { title: string; meta: string; on: boolean; onPick: () => void; onDelete?: () => void }) {
  const row = {
    type: 'button' as const,
    'aria-current': on || undefined,
    onClick: onPick,
    className: cn('flex w-full cursor-pointer flex-col items-start rounded-[10px] px-3 py-2 text-left', on ? 'bg-card ring-1 ring-border' : 'hover:bg-hover'),
  };
  const lines: ReactNode = (
    <>
      <span className="w-full truncate text-[13.5px] font-medium text-foreground">{title}</span>
      <span className="w-full truncate text-[12px] text-ink-3">{meta}</span>
    </>
  );
  if (onDelete === undefined) return <button {...row}>{lines}</button>;
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<button {...row} />}>{lines}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-36">
        <ContextMenuItem variant="destructive" onClick={onDelete}>Delete</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Asked before a draft goes: what it is called, and that the vault's history keeps it. */
function DeleteAsk({ draft, open, onOpenChange, onDelete }: { draft: Draft | null; open: boolean; onOpenChange: (open: boolean) => void; onDelete: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{draft?.title}”?</AlertDialogTitle>
          <AlertDialogDescription>It goes from the vault, for every task's agent too, committed and pushed; the vault's history keeps it.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onDelete}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The drafts, in their box: the list down the side, newest first, with New
 * above it, each deleted from its own menu, once asked, and the one picked
 * beside it, read and written in one place. The newest is shown first; with
 * none at all, a new one, ready to write. One whose writing failed as its
 * page went is shown again, being written. Nothing here waits on serve:
 * the list is the page's own, changed as each write is done.
 */
function DraftsBox() {
  const drafts = useDrafts();
  const list = drafts.data ?? NONE;
  const kept = useUI((s) => s.draftKept);
  // A write that failed after its draft was left takes it up again, over whatever is shown; one whose draft is gone meanwhile, as a new one.
  const keptAt = kept === null ? null : kept.id !== null && (!drafts.isSuccess || list.some((d) => d.id === kept.id)) ? kept.id : NEW;
  const [picked, setPicked] = useState<string | null>(keptAt);
  if (keptAt !== null && picked !== keptAt) setPicked(keptAt);
  // The one picked, while it is there; then the newest, or a new one when there are none.
  const shown = picked === NEW || list.some((d) => d.id === picked) ? (picked as string) : drafts.isSuccess ? list[0]?.id ?? NEW : null;
  const draft = list.find((d) => d.id === shown) ?? null;
  // A draft begun here keeps its page once it has an id, so its writing goes on uninterrupted, the caret where it was.
  const [born, setBorn] = useState<Readonly<Record<string, string>>>({});
  const onCreated = (id: string): void => {
    // The new one shown, picked or there being none.
    if (shown !== NEW) return;
    setBorn((b) => ({ ...b, [id]: NEW }));
    setPicked(id);
  };
  // The draft asked to be deleted, kept while the question closes.
  const [doomed, setDoomed] = useState<Draft | null>(null);
  const [asking, setAsking] = useState(false);
  const askDelete = (d: Draft): void => {
    setDoomed(d);
    setAsking(true);
  };
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
            <Row key={d.id} title={d.title} meta={`${when(d.changed)}${d.task ? ` · ${d.task}` : ''}`} on={d.id === shown} onPick={() => setPicked(d.id)} onDelete={() => askDelete(d)} />
          ))}
          {drafts.isSuccess && list.length === 0 && shown !== NEW ? <span className="px-2 text-[13px] text-ink-3">No drafts yet.</span> : null}
          {drafts.isError ? <span className="px-2 text-[13px] text-destructive">Could not read the drafts: {drafts.error.message}</span> : null}
        </div>
      </aside>
      {shown === null ? (
        <div className="flex items-center justify-center"><Spinner /></div>
      ) : (
        <DraftPage key={born[shown] ?? shown} draft={shown === NEW ? null : draft} kept={keptAt === shown ? kept : null}
          onCreated={onCreated} onAskDelete={askDelete} onGone={() => setPicked(null)} />
      )}
      {/* Deleted, it is gone from the list at once; serve refusing it puts it back and says why. */}
      <DeleteAsk draft={doomed} open={asking} onOpenChange={setAsking} onDelete={() => {
        setAsking(false);
        if (doomed !== null) void deleteDraft(doomed);
      }} />
    </>
  );
}

/**
 * The drafts' box over the page, opened from the task list. Escape while a
 * draft is being written only stops writing it; again, it closes the box,
 * which asks for what was written in it to be pushed now, once the writes
 * the closing set off are done.
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
      // After the box's pages have gone, each writing what it had left.
      if (!next) window.setTimeout(() => void pushDrafts(), 0);
    }}>
      <DialogContent showCloseButton={false} className="grid h-[min(820px,calc(100vh-4rem))] w-[min(1160px,calc(100vw-3rem))] max-w-none grid-cols-[272px_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:max-w-none">
        {open ? <DraftsBox /> : null}
      </DialogContent>
    </Dialog>
  );
}
