import { useEffect, useRef, useState } from 'react';
import { ApiError, postJSON, type ArtifactFile, type WriteResult } from '../../lib/api';
import { MOD, bytes, plural } from '../../lib/format';
import { Empty, Scroll } from '../../components/page';
import { Button } from '../../components/ui/button';
import { onStatus } from '../../state/server';
import { toast, useUI } from '../../state/ui';
import { spanInSource } from '../../components/review/locate';
import { useMarkdownText } from './markdownText';
import { scrollSourceTo, sourceLine, useReadingPlace } from './place';

/** One edit's place in the page's store: the file's path in the vault. */
const editOf = (key: string, text: string | undefined, sha: string): void =>
  useUI.setState((s) => {
    const { [key]: _gone, ...rest } = s.edits;
    return { edits: text === undefined ? rest : { ...s.edits, [key]: { sha, text } } };
  });

/**
 * A Markdown artifact's source, written in where it is shown: there is
 * nothing to open to edit it. What is typed is kept for as long as the page
 * is open, the rendered view and other files visited between, and saved
 * with ⌘S, which goes on editing, or with Save or Escape, which go back to
 * the rendered file once it is saved (`onDone`); Escape with nothing to
 * save goes straight back. serve commits it here at once, so it is shown
 * the moment it is saved, and pushes it on its own. Saving names the file
 * the editing began from, so one an agent wrote meanwhile is refused, not
 * written over, and what was typed stays, here, in Source. It opens where
 * the file was being read, rendered or here, and stays at what is being read
 * when an agent changes the file while nothing is typed in it.
 */
export function MarkdownSource({ task, file, onMeta, onDone }: { task: string; file: ArtifactFile; onMeta: (meta: string) => void; onDone?: () => void }) {
  const { key, loaded, edit, base, text: shown } = useMarkdownText(task, file);
  const text = shown ?? '';
  const [saving, setSaving] = useState(false);
  const dirty = edit !== undefined;
  const area = useRef<HTMLTextAreaElement>(null);
  useReadingPlace(key, base !== undefined, edit === undefined ? base : undefined, {
    el: () => area.current,
    text: () => area.current?.value,
    read: () => (area.current === null ? null : sourceLine(area.current)),
    go: (line) => {
      if (area.current !== null) scrollSourceTo(area.current, line);
    },
  });
  useEffect(() => {
    if (base !== undefined) onMeta(`Markdown source · ${plural(text.split('\n').length, 'line')} · ${bytes(file.size)}`);
  }, [base, text, file.size, onMeta]);
  // Opened by Edit on what was selected in the rendered file: the same words selected here, ready to be typed over.
  const select = useUI((s) => s.mdSelect);
  useEffect(() => {
    const el = area.current;
    if (base === undefined || el === null || select === null) return;
    useUI.setState({ mdSelect: null });
    if (select.key !== key) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(...spanInSource(el.value, select, select.quote));
  }, [base, select, key]);
  // Leaving the page with what is typed not saved: the browser asks first.
  useEffect(() => {
    if (!dirty) return;
    const hold = (e: BeforeUnloadEvent): void => e.preventDefault();
    addEventListener('beforeunload', hold);
    return () => removeEventListener('beforeunload', hold);
  }, [dirty]);

  /** Save what is typed; whether it is saved, or there was nothing to save. */
  const save = async (): Promise<boolean> => {
    if (saving) return false;
    if (edit === undefined) return true;
    setSaving(true);
    try {
      const out = await postJSON<WriteResult>('/api/artifact/edit', { task, path: file.path, sha: edit.sha, text: edit.text });
      // Shown as saved before the page has fetched it again, here and rendered: it is what serve now has.
      useUI.setState((s) => ({ saved: { ...s.saved, [key]: { sha: file.sha, text: edit.text } } }));
      editOf(key, undefined, edit.sha);
      if (out.warning) toast(`Saved here, but not committed: ${out.warning}`, true);
      void onStatus(out.status);
      return true;
    } catch (err) {
      toast(`Not saved: ${err instanceof ApiError ? err.message : (err as Error).message}`, true);
      return false;
    } finally {
      setSaving(false);
    }
  };
  /** Saved, back to the rendered file; refused, still here, with what was typed. */
  const saveAndGo = async (): Promise<void> => {
    if (await save()) onDone?.();
  };

  if (base === undefined && loaded.isError) return <Scroll><Empty><span className="text-destructive">{String(loaded.error.message)}</span></Empty></Scroll>;
  if (base === undefined) return <Scroll><Empty>Loading…</Empty></Scroll>;
  return (
    <div className="flex min-h-0 flex-auto flex-col">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-sunken px-5 text-[12.5px] text-ink-3">
        <span className="mr-auto" role="status">{saving ? 'Saving…' : dirty ? `Edited, not saved · ${MOD}S saves · Esc saves and shows it` : `Type to edit · ${MOD}S saves · Esc shows it`}</span>
        {dirty ? (
          <>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => editOf(key, undefined, edit.sha)}>Discard</Button>
            <Button size="sm" disabled={saving} onClick={() => void saveAndGo()}>Save</Button>
          </>
        ) : null}
      </div>
      <textarea ref={area} aria-label={`${file.path}, Markdown source`} spellCheck={false} value={text}
        className="min-h-0 flex-auto resize-none bg-transparent px-5 py-4 font-mono text-[13px] leading-[21px] whitespace-pre-wrap text-ink outline-none"
        onChange={(e) => editOf(key, e.target.value === base ? undefined : e.target.value, edit?.sha ?? file.sha)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'Enter')) {
            e.preventDefault();
            void save();
          }
          // Escape that an input method takes to cancel what it is composing is the input method's.
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void saveAndGo();
          }
        }} />
    </div>
  );
}
