import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { getJSON, type ArtifactFile, type FileVersion } from '../../lib/api';
import { dirName } from '../../lib/files';
import { plural, short, when } from '../../lib/format';
import { blocksOf } from '../../lib/markdown';
import { parsePatch, type PatchFile } from '../../lib/patch';
import { cn } from '../../lib/utils';
import { markWords } from '../../lib/words';
import { Empty, Scroll, Seg } from '../../components/page';
import { useText } from '../../state/server';
import { useUI } from '../../state/ui';
import { DIFF, DiffBody } from '../branch/Diff';
import { DiffScroll } from '../branch/Later';
import { LayoutTools } from '../branch/tools';
import { MarkdownDoc } from '../Markdown';

/** What changed inside a line, as `markWords` wraps it: deeper than the line's own tint, and not struck through or underlined, which a diff's colours already say. */
const WORDS = '[&_:is(ins,del)]:rounded-[3px] [&_:is(ins,del)]:no-underline [&_ins]:bg-[var(--diff-add-word)] [&_del]:bg-[var(--diff-del-word)]';

/** How a version came about, as its commit says: an edit on this page is named as one, anything else by the commit's own words. */
const saidOf = (v: FileVersion): string => (/ edited in yan serve$/.test(v.subject) ? 'Edited on the page' : v.subject);

/** A version's lines against the one before: what `git diff` says of the two, the words changed inside a line marked. */
function Changes({ v }: { v: FileVersion }) {
  const layout = useUI((s) => s.prefs.layout);
  // The first version is all new: there is nothing to compare it with, so its text is shown as added.
  const first = v.before === null;
  const patch = useText(!first && v.sha !== null ? `/api/artifact/diff?a=${v.before}&b=${v.sha}` : null);
  const whole = useText(first && v.sha !== null ? `/blob/${v.sha}` : null);
  const f = useMemo((): PatchFile | null => {
    if (whole.data !== undefined) {
      const lines = whole.data.replace(/\n$/, '').split('\n').map((t, i) => ({ k: 'add' as const, b: i + 1, t }));
      return { from: null, to: null, path: null, binary: false, note: [], hunks: [{ head: `@@ -0,0 +1,${lines.length} @@`, lines }] };
    }
    if (patch.data === undefined) return null;
    const parsed = parsePatch(patch.data)[0] ?? null;
    if (parsed !== null) markWords(parsed);
    return parsed;
  }, [patch.data, whole.data]);
  const error = patch.error ?? whole.error;
  let body: ReactNode = <Empty>Loading…</Empty>;
  if (v.sha === null) body = <Empty title="Deleted here">This version took the file out of the task.</Empty>;
  else if (error) body = <Empty><span className="text-destructive">{String(error.message)}</span></Empty>;
  else if (f !== null) body = <div className={cn(DIFF, WORDS)}><DiffBody f={f} layout={layout} /></div>;
  else if (patch.data !== undefined) body = <Empty>Nothing in its text changed.</Empty>;
  return <DiffScroll className="min-w-0">{body}</DiffScroll>;
}

/** A version drawn as the document it was, what is new in it since the one before tinted. */
function Document({ task, file, v }: { task: string; file: ArtifactFile; v: FileVersion }) {
  const text = useText(v.sha === null ? null : `/blob/${v.sha}`);
  const was = useText(v.before === null ? null : `/blob/${v.before}`);
  const before = useMemo(() => (was.data === undefined ? null : blocksOf(was.data)), [was.data]);
  if (v.sha === null) return <Scroll className="min-w-0"><Empty title="Deleted here">This version took the file out of the task.</Empty></Scroll>;
  if (text.data === undefined || (v.before !== null && was.data === undefined)) return <Scroll className="min-w-0"><Empty>Loading…</Empty></Scroll>;
  return <Scroll className="min-w-0"><MarkdownDoc text={text.data} task={task} dir={dirName(`artifacts/${file.path}`)} before={before} /></Scroll>;
}

/**
 * A Markdown file as it has been: every commit of the vault that changed
 * it, an agent's push or an edit on this page, the newest first, down the
 * right, and beside them what the one picked changed of the one before
 * it, the newest to start with. Changes shows it as a diff of the source,
 * the words changed inside a paragraph marked; Document draws the version
 * itself, what is new in it tinted. An agent and `user` both write these
 * files, and this is where each sees what the other did.
 */
export function MarkdownHistory({ task, file, onMeta }: { task: string; file: ArtifactFile; onMeta: (meta: string) => void }) {
  // Asked for again when the file changes: there is a version more.
  const history = useQuery({ queryKey: ['history', task, file.path, file.sha], queryFn: () => getJSON<FileVersion[]>(`/api/artifact/history?task=${encodeURIComponent(task)}&path=${encodeURIComponent(file.path)}`) });
  const [picked, setPicked] = useState<string | null>(null);
  const [as, setAs] = useState<'changes' | 'doc'>('changes');
  const list = history.data;
  useEffect(() => {
    if (list !== undefined) onMeta(`Markdown history · ${plural(list.length, 'version')}`);
  }, [list, onMeta]);
  if (history.isError) return <Scroll><Empty><span className="text-destructive">{String(history.error.message)}</span></Empty></Scroll>;
  if (list === undefined) return <Scroll><Empty>Loading…</Empty></Scroll>;
  const v = list.find((x) => x.commit === picked) ?? list[0];
  if (v === undefined) return <Scroll><Empty title="No history yet">This file is in no commit of the vault yet.</Empty></Scroll>;
  return (
    <div className="flex min-h-0 flex-auto">
      {as === 'changes' ? <Changes key={v.commit} v={v} /> : <Document key={v.commit} task={task} file={file} v={v} />}
      <aside className="flex w-[280px] flex-none flex-col border-l border-sunken" aria-label="Versions">
        <div className="flex flex-none flex-col gap-2 border-b border-sunken p-3">
          <Seg options={[['changes', 'Changes'], ['doc', 'Document']] as const} current={as} onPick={setAs} wide />
          {/* How the changes are laid out, as a branch's are; the document has one way to be drawn. */}
          {as === 'changes' ? <LayoutTools /> : null}
        </div>
        <ol className="min-h-0 flex-auto overflow-y-auto p-2">
          {list.map((x, i) => (
            <li key={x.commit}>
              <button type="button" aria-current={x === v ? 'true' : undefined} onClick={() => setPicked(x.commit)}
                className={cn('flex w-full flex-col gap-0.5 rounded-[8px] px-2.5 py-2 text-left hover:bg-sunken', x === v && 'bg-sunken')}>
                <span className="flex items-baseline gap-2 text-[13px] font-bold text-ink">
                  {when(x.at)}
                  {i === 0 ? <span className="text-[11.5px] font-normal text-brand">current</span> : null}
                  <span className="ml-auto font-mono text-[11.5px] font-normal">
                    {x.add === null ? null : <><span className="text-success">{`+${x.add}`}</span>{' '}<span className="text-destructive">{`−${x.del}`}</span></>}
                  </span>
                </span>
                <span className="line-clamp-2 text-[12.5px] leading-[18px] text-ink-2 wrap-anywhere">{saidOf(x)}</span>
                <span className="truncate text-[11.5px] text-ink-3">{`${x.author} · ${short(x.commit)}`}</span>
              </button>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}
