import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Draft } from '../../lib/api';
import { when } from '../../lib/format';
import { cn } from '../../lib/utils';
import { useUI, type KeptDraft } from '../../state/ui';
import { MarkdownDoc } from '../../views/Markdown';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { DialogClose } from '../ui/dialog';
import { offsetAt, saveDraft } from './save';

/** The draft's room, read and written alike: the same margins and the same face, so turning from one to the other moves nothing. */
const ROOM = 'min-h-0 flex-1 px-10 pt-7 pb-16';

/**
 * Deleting a draft, asked twice, as closing a terminal's tab is: the first
 * click only turns it to say so, which goes back after a few seconds untouched.
 */
function Delete({ onDelete }: { onDelete: () => void }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const back = window.setTimeout(() => setSure(false), 3000);
    return () => window.clearTimeout(back);
  }, [sure]);
  return (
    <Button variant={sure ? 'destructive' : 'ghost'} size="sm" className={cn('font-normal', !sure && 'text-ink-3')} aria-label={sure ? 'Really delete this draft' : 'Delete this draft'}
      onClick={() => { if (sure) onDelete(); else setSure(true); }}>
      <Icon name="trash" size={14} />{sure ? 'Delete' : null}
    </Button>
  );
}

/**
 * One draft, as it reads, which a click turns into its Markdown being
 * written, where the click fell, in the same place: there is no mode to go
 * to. Leaving it, by a click elsewhere, Escape or ⌘↩, saves what changed,
 * and a draft left blank is removed. `fresh` is a draft begun here, written
 * from the start and kept only once something is in it; `kept`, one whose
 * saving failed, taken up again as it was left.
 */
export function DraftPage({ draft, fresh, kept, onSaved }: { draft: Draft | undefined; fresh: boolean; kept: KeptDraft | null; onSaved: (id: string | null) => void }) {
  const text = draft?.text ?? '';
  // What was saved last, shown until the drafts fetched again have it.
  const [saving, setSaving] = useState<string | null>(null);
  const shown = saving ?? text;
  const [editing, setEditing] = useState(fresh || kept !== null);
  const [value, setValue] = useState(kept?.text ?? text);
  const [from, setFrom] = useState(kept?.sha ?? draft?.sha ?? '');
  const caret = useRef<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
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
  // Leaving the page with what is written not saved: the browser asks first.
  const unsaved = editing && value !== shown;
  useEffect(() => {
    if (!unsaved) return;
    const hold = (e: BeforeUnloadEvent): void => e.preventDefault();
    addEventListener('beforeunload', hold);
    return () => removeEventListener('beforeunload', hold);
  }, [unsaved]);

  const save = (next: string, sha: string): void => {
    setSaving(next);
    void saveDraft({ id: fresh ? null : (draft as Draft).id, sha, text: next }).then((out) => {
      if (!live.current) return;
      setSaving(null);
      if (out !== undefined) return onSaved(out.id);
      // Still here: written on, as it was, in place of being opened again over the box.
      useUI.setState({ draftKept: null });
      setValue(next);
      setEditing(true);
    });
  };
  const begin = (at: number | null): void => {
    if (saving !== null) return;
    caret.current = at;
    setValue(shown);
    setFrom(draft?.sha ?? '');
    setEditing(true);
  };
  const leave = (): void => {
    setEditing(false);
    if (value === shown || (fresh && value.trim() === '')) return;
    save(value, from);
  };

  const meta = saving !== null ? 'Saving…'
    : editing ? (fresh ? 'A new draft: its first line is its title' : 'Writing · saved when you click away, or Esc')
    : fresh ? 'A new draft' : `${draft ? `Edited ${when(draft.changed)}` : ''}${draft?.task ? ` · kept with ${draft.task}` : ''} · click it to write`;
  return (
    <section className="flex min-w-0 flex-col" aria-label={fresh ? 'New draft' : draft?.title ?? 'Draft'}>
      <div className="flex h-12 flex-none items-center gap-1 border-b border-sunken pr-2 pl-10 text-[12.5px] text-ink-3">
        <span className="min-w-0 flex-1 truncate">{meta}</span>
        {draft && !fresh && saving === null ? <Delete onDelete={() => save('', draft.sha)} /> : null}
        <DialogClose render={<Button variant="ghost" size="icon-sm" className="text-ink-3" aria-label="Close" />}><Icon name="close" size={16} /></DialogClose>
      </div>
      {editing ? (
        <textarea ref={area} data-draft aria-label="Draft" spellCheck={false} value={value} placeholder="Write here. The first line is its title."
          className={cn(ROOM, 'resize-none bg-transparent font-sans text-[15px] leading-[27px] text-[color:var(--doc-ink)] outline-none placeholder:text-ink-4')}
          onChange={(e) => setValue(e.target.value)} onBlur={leave}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }} />
      ) : (
        // Read, the draft is where its writing begins: a click on it, not on a link in it and not ending a selection, writes there.
        <div className={cn(ROOM, 'cursor-text overflow-y-auto')} role="document" aria-label="Draft, click to write"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('a') || !(getSelection()?.isCollapsed ?? true)) return;
            begin(shown.trim() === '' ? null : offsetAt(e.clientX, e.clientY, shown));
          }}>
          {shown.trim() === '' ? <p className="text-[15px] text-ink-4">Nothing written yet. Click to write.</p> : <MarkdownDoc text={shown} bare />}
        </div>
      )}
    </section>
  );
}
