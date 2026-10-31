import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { postJSON, type TaskDetail, type TaskSummary, type WriteResult } from '../../lib/api';
import { when } from '../../lib/format';
import { blocksOf } from '../../lib/markdown';
import { Icon } from '../../components/Icon';
import { Button } from '../../components/ui/button';
import { onStatus, useText } from '../../state/server';
import { setSeen, toast, useUI } from '../../state/ui';
import { MarkdownDoc } from '../Markdown';
import { Section } from './Section';

/**
 * problem.md opened to edit, whole, as the Markdown it is. Saving is refused
 * when an agent changed the file since this page read it, so neither
 * overwrites the other; while it is open, what is typed stays, whatever
 * arrives.
 */
function ProblemEditor({ t, d, onClose }: { t: TaskSummary; d: TaskDetail; onClose: () => void }) {
  const text = d.problem?.text ?? '';
  // The sha the edit started from, so a save after an agent's change is refused.
  const [from] = useState(d.problem?.sha ?? '');
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [value]);
  useEffect(() => area.current?.focus(), []);
  const save = (): void => {
    if (value.trim() === '') return toast('problem.md cannot be blank');
    if (value === text) return onClose();
    setBusy(true);
    postJSON<WriteResult>('/api/problem', { task: t.id, sha: from, text: value }).then((out) => {
      toast(out.warning ? `Saved problem.md, but the push failed: ${out.warning}` : 'Saved problem.md');
      onClose();
      void onStatus(out.status);
    }, (err: Error) => {
      setBusy(false);
      toast(`Not saved: ${err.message}`, true);
    });
    return undefined;
  };
  return (
    <>
      {/* The problem whole, in the page's own face, growing with what is typed rather than scrolling. */}
      <textarea ref={area} spellCheck={false} aria-label="problem.md" value={value} onChange={(e) => setValue(e.target.value)}
        className="block min-h-60 w-full resize-none overflow-hidden rounded-[12px] bg-card px-4 py-3.5 font-sans text-[14.5px] leading-[1.75] text-ink ring-1 ring-border focus:ring-[1.5px] focus:ring-brand focus:outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            save();
          }
          if (e.key === 'Escape') {
            if (value === text) onClose();
            else toast('There are changes not saved: Cancel throws them away');
          }
        }} />
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <span className="mr-auto text-[12.5px] text-ink-3">Markdown · ⌘↩ saves · Esc cancels</span>
        <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={busy} onClick={save}>Save</Button>
      </div>
    </>
  );
}

/**
 * problem.md, with what changed since the last look tinted. The visit's
 * starting point is kept for as long as the task is open, so the tint stays
 * while it is read, and the file counts as seen once shown.
 */
export function Problem({ t, d }: { t: TaskSummary; d: TaskDetail }) {
  const [editing, setEditing] = useState(false);
  const problem = d.problem;
  // Where this visit started from: kept once the problem is shown, and until then what was last seen.
  const was = useUI((s) => (t.id in s.problemBase ? s.problemBase[t.id] : s.seen?.problems[t.id]) ?? null);
  useEffect(() => {
    if (!problem?.text.trim()) return;
    const s = useUI.getState();
    if (!(t.id in s.problemBase)) useUI.setState({ problemBase: { ...s.problemBase, [t.id]: s.seen?.problems[t.id] ?? null } });
    setSeen((seen) => (seen.problems[t.id] === problem.sha ? null : { ...seen, problems: { ...seen.problems, [t.id]: problem.sha } }));
  }, [t.id, problem]);
  const old = useText(problem && was && was !== problem.sha ? `/blob/${was}` : null);
  const before = useMemo(() => (old.data !== undefined ? blocksOf(old.data) : null), [old.data]);
  const waiting = !!problem && !!was && was !== problem.sha && old.data === undefined && !old.isError;
  const fresh = useMemo(() => !!before && !!problem && [...blocksOf(problem.text)].some((b) => b !== '' && !before.has(b)), [before, problem]);

  const edit = editing ? null : <Button variant="ghost" size="sm" className="ml-auto font-normal text-ink-3" onClick={() => setEditing(true)}><Icon name="edit" size={14} />Edit</Button>;
  if (!problem || !problem.text.trim()) {
    return (
      <Section title="Problem" tools={edit}>
        {editing ? <ProblemEditor t={t} d={d} onClose={() => setEditing(false)} /> : <div><span className="text-ink-3">No problem written yet.</span></div>}
      </Section>
    );
  }
  const name = problem.path.slice(problem.path.lastIndexOf('/') + 1);
  return (
    <Section title="Problem" meta={`${name}${problem.changed ? ` · written ${when(problem.changed)}` : ''}`} tools={edit}>
      {editing ? <ProblemEditor t={t} d={d} onClose={() => setEditing(false)} /> : (
        <div>{waiting ? null : <MarkdownDoc text={problem.text} task={t.id} dir="" before={before} dropTitle bare />}</div>
      )}
      {!editing && fresh ? <span className="text-[12.5px] text-ink-3">The tinted parts are new since you last looked.</span> : null}
    </Section>
  );
}
