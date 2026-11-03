import { useEffect, useEffectEvent, useRef, useState } from 'react';
import type { Draft } from '../../lib/api';
import { toast, useUI, type KeptDraft } from '../../state/ui';
import { Conflicted, wasDeleted, writeDraft } from './save';

/** Where the writing stands with this machine's disk: written, being written, not written yet, or refused. */
export type Saving = 'saved' | 'saving' | 'unsaved' | 'failed';

/** How long the typing pauses before what was typed is written. */
const PAUSE_MS = 700;

/** What one draft's writing knows, read and changed by its handlers, never drawn: the drawn copy is the state beside it. */
interface At {
  id: string | null;
  /** The draft as the writing began from it, which each write names. */
  sha: string;
  /** What is on disk as far as this page knows; null when it is not known, so the text is written. */
  saved: string | null;
  text: string;
  /** Refused as changed elsewhere: nothing more is written until `user` says which to keep. */
  conflict: Draft | null | undefined;
  /** Its page has gone, the box closed or another draft picked: what is left is written as it can be. */
  gone: boolean;
}

/**
 * One draft's writing: what is typed is written to this machine's disk a
 * moment after the typing pauses, and at once when the writing is left,
 * one write after another, so each names the draft as the last left it.
 * Nothing waits on it: the page goes on drawing what is typed. A write
 * refused as changed elsewhere stops the writing and says what it is now,
 * for `user` to keep theirs, the other, or both. Left with something not
 * written, as its page goes, it is written still; refused then, it is kept
 * as a new draft, and failing that, the box opens on it again.
 */
export function useWriter(draft: Draft | null, kept: KeptDraft | null, onCreated: (id: string) => void) {
  const begun = kept ?? (draft === null ? { id: null, sha: '', text: '' } : { id: draft.id, sha: draft.sha, text: draft.text });
  const at = useRef<At>({ id: begun.id, sha: begun.sha, saved: kept === null ? begun.text : null, text: begun.text, conflict: undefined, gone: false });
  const [text, setText] = useState(begun.text);
  const [saving, setSaving] = useState<Saving>(kept === null ? 'saved' : 'unsaved');
  const [conflict, setConflict] = useState<{ theirs: Draft | null } | null>(null);
  const busy = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const timer = useRef(0);
  const created = useRef(onCreated);
  useEffect(() => {
    created.current = onCreated;
  });

  const write = async (): Promise<void> => {
    window.clearTimeout(timer.current);
    const a = at.current;
    if (busy.current !== null) {
      again.current = true;
      return;
    }
    if (wasDeleted(a.id) || a.text.trim() === '' || (a.text === a.saved && a.conflict === undefined)) return;
    // Refused once, it waits for `user`; gone with that unsettled, what was written is kept as a new draft beside theirs.
    if (a.conflict !== undefined && !a.gone) return;
    const [id, sha, sent] = a.conflict !== undefined ? [null, '', a.text] : [a.id, a.sha, a.text];
    setSaving('saving');
    const done = writeDraft(id, sha, sent).then((d) => {
      if (a.id === null || a.conflict !== undefined) created.current(d.id);
      Object.assign(a, { id: d.id, sha: d.sha, saved: sent, conflict: undefined });
      setSaving(a.text === sent ? 'saved' : 'unsaved');
    }, (err: unknown) => {
      if (err instanceof Conflicted) {
        a.conflict = err.theirs;
        setConflict({ theirs: err.theirs });
        setSaving('unsaved');
        if (a.gone) again.current = true;
        return;
      }
      setSaving('failed');
      toast(`The draft was not saved: ${(err as Error).message}`, true);
      // Gone, what was written would be lost: the box opens on it again.
      if (a.gone) useUI.setState({ drafts: true, draftKept: { id: a.id, sha: a.sha, text: a.text } });
    });
    busy.current = done;
    await done;
    busy.current = null;
    if (again.current) {
      again.current = false;
      await write();
    }
  };

  // Gone, what is not written yet is written still.
  const leave = useEffectEvent(() => {
    at.current.gone = true;
    void write();
  });
  useEffect(() => {
    at.current.gone = false;
    return () => leave();
  }, []);

  const change = (next: string): void => {
    at.current.text = next;
    setText(next);
    if (busy.current === null) setSaving(next === at.current.saved ? 'saved' : 'unsaved');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void write(), PAUSE_MS);
  };
  return {
    text,
    saving,
    conflict,
    /** The draft's id, null until a new one is first written. */
    id: (): string | null => at.current.id,
    /** Typed: written once the typing pauses. */
    change,
    /** `md` put in at `pos`, on lines of its own; returns where it ends. */
    insert(pos: number, md: string): number {
      const now = at.current.text;
      const before = now.slice(0, Math.min(pos, now.length));
      const lead = before === '' || before.endsWith('\n') ? '' : '\n';
      change(`${before}${lead}${md}\n${now.slice(before.length)}`);
      return before.length + lead.length + md.length + 1;
    },
    /** Written now, the writing left; resolves once it is, with the draft's id. */
    async flush(): Promise<string | null> {
      await write();
      if (busy.current !== null) await busy.current;
      return at.current.id;
    },
    /** Begun again from the draft as it is now, when nothing is waiting to be written: a change from elsewhere is taken up. */
    adopt(d: Draft): void {
      const a = at.current;
      if (a.text !== a.saved || a.conflict !== undefined || busy.current !== null) return;
      Object.assign(a, { id: d.id, sha: d.sha, saved: d.text, text: d.text });
      setText(d.text);
    },
    /** What was written put back as it is on disk, a draft left blank not being kept blank. */
    revert(): void {
      const a = at.current;
      if (a.saved === null) return;
      window.clearTimeout(timer.current);
      a.text = a.saved;
      setText(a.saved);
      setSaving('saved');
    },
    /** Refused, theirs written over with this. */
    keepMine(): void {
      const a = at.current;
      if (a.conflict === undefined) return;
      Object.assign(a, a.conflict === null ? { id: null, sha: '' } : { sha: a.conflict.sha }, { saved: null, conflict: undefined });
      setConflict(null);
      void write();
    },
    /** Refused, theirs taken in place of this; one deleted elsewhere let go of. */
    useTheirs(): void {
      const a = at.current;
      if (a.conflict === undefined) return;
      const theirs = a.conflict?.text ?? a.text;
      Object.assign(a, { sha: a.conflict?.sha ?? a.sha, saved: theirs, text: theirs, conflict: undefined });
      setText(theirs);
      setConflict(null);
      setSaving('saved');
    },
    /** Refused, this kept as a new draft beside theirs. */
    keepBoth(): void {
      const a = at.current;
      if (a.conflict === undefined) return;
      Object.assign(a, { id: null, sha: '', saved: null, conflict: undefined });
      setConflict(null);
      void write();
    },
  };
}
