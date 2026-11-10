import { useEffect, useRef, useState } from 'react';
import { ApiError, postJSON, type ArtifactFile, type WriteResult } from '../../lib/api';
import { bytes, plural } from '../../lib/format';
import { Empty, Scroll } from '../../components/page';
import { Button } from '../../components/ui/button';
import { onStatus, useText, vaultPath } from '../../state/server';
import { toast, useUI } from '../../state/ui';
import { scrollSourceTo, sourceLine, useKeepPlace, type Sync } from './place';

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
 * with ⌘S or Save: serve commits it here at once, so it is shown the moment
 * it is saved, and pushes it on its own. Saving names the file the editing
 * began from, so one an agent wrote meanwhile is refused, not written over,
 * and what was typed stays. Swapped in for the rendered file, it opens where
 * that was being read, and says where it is when swapped back.
 */
export function MarkdownSource({ task, file, onMeta, sync }: { task: string; file: ArtifactFile; onMeta: (meta: string) => void; sync?: Sync }) {
  const key = vaultPath(task, file.path);
  const loaded = useText(`/blob/${file.sha}`);
  const edit = useUI((s) => s.edits[key]);
  const [saving, setSaving] = useState(false);
  // What was saved last, shown as the file until the page has fetched the commit it made, not the file as it was.
  const [saved, setSaved] = useState<{ readonly key: string; readonly sha: string; readonly text: string } | null>(null);
  const mine = saved !== null && saved.key === key ? saved : null;
  const base = mine !== null && (mine.sha === file.sha || loaded.data === undefined) ? mine.text : loaded.data;
  const text = edit?.text ?? base ?? '';
  const dirty = edit !== undefined;
  const area = useRef<HTMLTextAreaElement>(null);
  useKeepPlace(sync, key, base !== undefined, {
    read: () => (area.current === null ? null : sourceLine(area.current)),
    go: (line) => {
      if (area.current !== null) scrollSourceTo(area.current, line);
    },
  });
  useEffect(() => {
    if (base !== undefined) onMeta(`Markdown source · ${plural(text.split('\n').length, 'line')} · ${bytes(file.size)}`);
  }, [base, text, file.size, onMeta]);
  // Leaving the page with what is typed not saved: the browser asks first.
  useEffect(() => {
    if (!dirty) return;
    const hold = (e: BeforeUnloadEvent): void => e.preventDefault();
    addEventListener('beforeunload', hold);
    return () => removeEventListener('beforeunload', hold);
  }, [dirty]);

  const save = async (): Promise<void> => {
    if (edit === undefined || saving) return;
    setSaving(true);
    try {
      const out = await postJSON<WriteResult>('/api/artifact/edit', { task, path: file.path, sha: edit.sha, text: edit.text });
      // Shown as saved before the page has fetched it again: it is what serve now has.
      setSaved({ key, sha: file.sha, text: edit.text });
      editOf(key, undefined, edit.sha);
      if (out.warning) toast(`Saved here, but not committed: ${out.warning}`, true);
      void onStatus(out.status);
    } catch (err) {
      toast(`Not saved: ${err instanceof ApiError ? err.message : (err as Error).message}`, true);
    } finally {
      setSaving(false);
    }
  };

  if (base === undefined && loaded.isError) return <Scroll><Empty><span className="text-destructive">{String(loaded.error.message)}</span></Empty></Scroll>;
  if (base === undefined) return <Scroll><Empty>Loading…</Empty></Scroll>;
  return (
    <div className="flex min-h-0 flex-auto flex-col">
      <div className="flex h-11 flex-none items-center gap-2 border-b border-sunken px-5 text-[12.5px] text-ink-3">
        <span className="mr-auto" role="status">{saving ? 'Saving…' : dirty ? 'Edited, not saved · ⌘S saves' : 'Type to edit · ⌘S saves'}</span>
        {dirty ? (
          <>
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => editOf(key, undefined, edit.sha)}>Discard</Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>Save</Button>
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
        }} />
    </div>
  );
}
