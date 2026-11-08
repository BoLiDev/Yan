import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import type { Draft } from '../../lib/api';
import { when } from '../../lib/format';
import { cn } from '../../lib/utils';
import { toast, useUI, type KeptDraft } from '../../state/ui';
import { MarkdownDoc } from '../../views/Markdown';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { DialogClose } from '../ui/dialog';
import { addPicture, isPicture, offsetAt } from './save';
import { useWriter, type Saving } from './writer';

/** The draft's room, read and written alike: the same margins and the same face, so turning from one to the other moves nothing. */
const ROOM = 'min-h-0 flex-1 px-10 pt-7 pb-16';

/** A click is a click, not the end of a selection dragged across the text, while the pointer moves less than this. */
const STILL_PX = 4;

/** What the header says of the writing, and of the push the box's writing waits for. */
function said(saving: Saving, editing: boolean, push: { pending: boolean; error: string | null } | undefined): string {
  if (saving === 'saving') return 'Saving…';
  if (saving === 'failed') return 'Not saved';
  if (saving === 'unsaved') return editing ? '' : 'Not saved yet';
  if (push?.error) return `Saved here, not pushed: ${push.error}`;
  return push?.pending ? 'Saved, pushing soon' : '';
}

/** A draft changed or deleted elsewhere while it was written here: which to keep. */
function Clash({ theirs, onMine, onTheirs, onBoth }: { theirs: Draft | null; onMine: () => void; onTheirs: () => void; onBoth: () => void }) {
  return (
    <div role="alert" className="flex flex-none flex-wrap items-center gap-2 border-b border-sunken bg-warning-soft px-10 py-2.5 text-[13px]">
      <span className="mr-auto">{theirs === null ? 'This draft was deleted elsewhere while you wrote it.' : 'This draft changed elsewhere while you wrote it.'}</span>
      <Button size="sm" variant="secondary" onClick={onMine}>{theirs === null ? 'Keep it' : 'Keep mine'}</Button>
      <Button size="sm" variant="secondary" onClick={onTheirs}>{theirs === null ? 'Let it go' : 'Use theirs'}</Button>
      {theirs === null ? null : <Button size="sm" variant="secondary" onClick={onBoth}>Keep both</Button>}
    </div>
  );
}

/**
 * One draft, as it reads, which a click turns into its Markdown being
 * written, where the click fell, in the same place, at once: there is no
 * mode to go to and nothing to wait for. What is typed is written to this
 * machine as the typing pauses, and the push follows on its own. Leaving
 * it, by a click elsewhere, Escape or ⌘↩, stops writing; a draft left blank
 * is not kept blank: it asks to be deleted. A picture pasted or dropped on
 * it is kept beside it, and named in it where the caret is. `draft` null is
 * one begun here; `kept`, one whose writing failed as its page went.
 */
export function DraftPage({ draft, kept, onCreated, onAskDelete, onGone }: {
  draft: Draft | null;
  kept: KeptDraft | null;
  onCreated: (id: string) => void;
  onAskDelete: (d: Draft) => void;
  onGone: () => void;
}) {
  const writer = useWriter(draft, kept, onCreated);
  const [editing, setEditing] = useState(draft === null || kept !== null);
  const push = useUI((s) => s.status?.push);
  const caret = useRef<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const down = useRef<{ x: number; y: number } | null>(null);
  // A kept draft is taken up here, so the box does not take it up again.
  useEffect(() => {
    if (kept !== null) useUI.setState({ draftKept: null });
  }, [kept]);
  useLayoutEffect(() => {
    const el = area.current;
    if (!editing || !el) return;
    const at = Math.min(caret.current ?? el.value.length, el.value.length);
    el.focus();
    el.setSelectionRange(at, at);
  }, [editing]);
  // Read, with nothing of its own waiting, it is the draft as it is now, a change from elsewhere included.
  const shown = !editing && writer.saving === 'saved' && writer.conflict === null && draft !== null ? draft.text : writer.text;

  const begin = (at: number | null): void => {
    if (draft !== null) writer.adopt(draft);
    caret.current = at;
    setEditing(true);
  };
  const leave = (): void => {
    setEditing(false);
    if (writer.text.trim() !== '') return void writer.flush();
    if (draft !== null && writer.id() !== null) {
      writer.revert();
      onAskDelete(draft);
    }
  };
  /** Pictures kept beside the draft, a new one made for them when there is none, and named in it at `at`. */
  const pictures = async (files: readonly File[], at: number): Promise<void> => {
    let id = writer.id();
    if (id === null && writer.text.trim() !== '') id = await writer.flush();
    const lines: string[] = [];
    let end = at;
    for (const file of files) {
      try {
        const out = await addPicture(id, file);
        if (id === null) {
          // Made for the picture, the draft is its line already.
          id = out.draft.id;
          onCreated(id);
          writer.adopt(out.draft);
          end = out.draft.text.length;
        } else lines.push(`![](${out.path})`);
      } catch (err) {
        toast(`The picture was not kept: ${(err as Error).message}`, true);
      }
    }
    if (lines.length > 0) end = writer.insert(end, lines.join('\n\n'));
    caret.current = end;
    requestAnimationFrame(() => area.current?.setSelectionRange(end, end));
  };
  const take = (files: readonly File[], at: number | null): boolean => {
    const pics = files.filter(isPicture);
    if (pics.length === 0) return false;
    if (!editing) begin(null);
    void pictures(pics, at ?? writer.text.length);
    return true;
  };
  // Read, a picture pasted anywhere in the box goes at the draft's end.
  const pasted = useEffectEvent((e: ClipboardEvent) => {
    if (take([...(e.clipboardData?.files ?? [])], null)) e.preventDefault();
  });
  useEffect(() => {
    if (editing) return;
    const on = (e: ClipboardEvent): void => pasted(e);
    document.addEventListener('paste', on);
    return () => document.removeEventListener('paste', on);
  }, [editing]);

  const meta = `${draft === null ? 'A new draft' : `Begun ${when(draft.begun)}`}${draft?.task ? ` · kept with ${draft.task}` : ''}${editing ? '' : ' · click it to write'}`;
  const state = said(writer.saving, editing, push);
  return (
    <section className="flex min-w-0 flex-col" aria-label={draft?.title ?? 'New draft'}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
      onDrop={(e) => { if (take([...e.dataTransfer.files], editing ? area.current?.selectionStart ?? null : null)) e.preventDefault(); }}>
      <div className="flex h-12 flex-none items-center gap-3 border-b border-sunken pr-2 pl-10 text-[12.5px] text-ink-3">
        <span className="min-w-0 flex-1 truncate">{meta}</span>
        {state ? <span className={cn('truncate', writer.saving === 'failed' && 'text-destructive')} role="status">{state}</span> : null}
        <DialogClose render={<Button variant="ghost" size="icon-sm" className="text-ink-3" aria-label="Close" />}><Icon name="close" size={16} /></DialogClose>
      </div>
      {writer.conflict ? (
        <Clash theirs={writer.conflict.theirs} onMine={writer.keepMine} onBoth={writer.keepBoth}
          onTheirs={() => { writer.useTheirs(); if (writer.conflict?.theirs === null) onGone(); }} />
      ) : null}
      {editing ? (
        <textarea ref={area} data-draft aria-label="Draft" spellCheck={false} value={writer.text} placeholder="Write here. The first line is its title; paste a picture to keep it here."
          className={cn(ROOM, 'resize-none bg-transparent font-sans text-[15px] leading-[27px] text-[color:var(--doc-ink)] outline-none placeholder:text-ink-4')}
          onChange={(e) => writer.change(e.target.value)} onBlur={leave}
          onPaste={(e) => { if (take([...e.clipboardData.files], e.currentTarget.selectionStart)) e.preventDefault(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }} />
      ) : (
        // Read, the draft is where its writing begins: a click on it, not on a link in it and not ending a selection dragged across it, writes there.
        <div className={cn(ROOM, 'cursor-text overflow-y-auto')} role="document" aria-label="Draft, click to write"
          onMouseDown={(e) => { down.current = { x: e.clientX, y: e.clientY }; }}
          onClick={(e) => {
            const from = down.current;
            if ((e.target as HTMLElement).closest('a') || (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > STILL_PX)) return;
            begin(shown.trim() === '' ? null : offsetAt(e.clientX, e.clientY, shown));
          }}>
          {shown.trim() === '' ? <p className="text-[15px] text-ink-4">Nothing written yet. Click to write, or paste a picture.</p>
            : <MarkdownDoc text={shown} base={draft?.task ? `tasks/${draft.task}/drafts` : 'drafts'} bare />}
        </div>
      )}
    </section>
  );
}
