import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactFile } from '../../lib/api';
import { dirName } from '../../lib/files';
import { plural, when } from '../../lib/format';
import { langReady } from '../../lib/highlight';
import { renderMarkdownDiff } from '../../lib/markdownDiff';
import { cn } from '../../lib/utils';
import { Icon } from '../../components/Icon';
import { Empty, Scroll } from '../../components/page';
import { Button } from '../../components/ui/button';
import { filesOrigin, useTask, useText } from '../../state/server';
import { useUI } from '../../state/ui';
import { DOC } from '../doc';
import { saidOf, useHistory } from './history';

/**
 * What became of each block, as `renderMarkdownDiff` holds it: one added
 * tinted green, one taken out red and struck through, one changed left as
 * it is with the words put in and taken out marked inside it. Out to a
 * little past the text on either side, as what is new since a visit is.
 */
const DIFFED = [
  '[&_[data-diff]]:-mx-3.5 [&_[data-diff]]:mb-3 [&_[data-diff]]:rounded-[10px] [&_[data-diff]]:px-3.5 [&_[data-diff]]:pt-2 [&_[data-diff]]:pb-px',
  '[&_[data-diff=add]]:bg-[var(--diff-add)]',
  '[&_[data-diff=del]]:bg-[var(--diff-del)] [&_[data-diff=del]]:line-through [&_[data-diff=del]]:decoration-[color:var(--red)]/50 [&_[data-diff=del]_*]:text-ink-3',
  // A heading's own space above it is the holder's.
  '[&_[data-diff]>:first-child]:mt-0',
  '[&_ins]:rounded-[3px] [&_ins]:bg-[var(--diff-add-word)] [&_ins]:no-underline',
  '[&_del]:rounded-[3px] [&_del]:bg-[var(--diff-del-word)] [&_del]:text-ink-3 [&_del]:decoration-[color:var(--red)]/60',
].join(' ');

/**
 * What one version of a Markdown file changed of the one before it, drawn
 * as the document: the text as that version had it, with what it added,
 * took out and reworded marked in it, opened at the first of them. Over it,
 * which version it is, the ways to the one before and the one after, and
 * the way back to the file as it is. An agent and `user` both write these
 * files, and this is where each sees what the other did.
 */
export function MarkdownHistory({ task, file, commit, onMeta }: { task: string; file: ArtifactFile; commit: string; onMeta: (meta: string) => void }) {
  const history = useHistory(task, file, true);
  const list = history.data;
  const at = list?.findIndex((x) => x.commit === commit) ?? -1;
  const v = list?.[at];
  const now = useText(v?.sha ? `/blob/${v.sha}` : null);
  const was = useText(v?.before ? `/blob/${v.before}` : null);
  const { data: d } = useTask(task);
  const files = d?.files;
  // Colouring waits for a fenced block's language: once it is loaded, the text is made again.
  const [loaded, setLoaded] = useState(0);
  const ready = v !== undefined && now.data !== undefined && (v.before === null || was.data !== undefined);
  const rendered = useMemo(
    () => (ready ? renderMarkdownDiff(v.before === null ? null : was.data ?? '', now.data ?? '', { task, dir: dirName(`artifacts/${file.path}`), files, filesOrigin: filesOrigin() }) : null),
    // `loaded` stands for the languages highlight.js has loaded, which the rendering reads: one arriving makes it again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [ready, v, was.data, now.data, task, file.path, files, loaded],
  );
  useEffect(() => {
    if (!rendered?.waiting.length) return;
    let live = true;
    void Promise.all(rendered.waiting.map(langReady)).then(() => {
      if (live) setLoaded((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [rendered?.waiting]);
  useEffect(() => {
    if (list !== undefined) onMeta(`Markdown · ${plural(list.length, 'version')}${rendered ? ` · ${plural(rendered.changed, 'block')} changed here` : ''}`);
  }, [list, rendered, onMeta]);
  // Opened at the first thing changed, which may be far down a long file.
  const doc = useRef<HTMLDivElement>(null);
  const html = rendered?.html;
  useLayoutEffect(() => {
    if (html !== undefined) doc.current?.querySelector('[data-diff], ins, del')?.scrollIntoView({ block: 'center' });
  }, [html, commit]);

  const go = (to: string | null): void => useUI.setState({ mdVersion: to });
  if (history.isError) return <Scroll><Empty><span className="text-destructive">{String(history.error.message)}</span></Empty></Scroll>;
  if (list === undefined) return <Scroll><Empty>Loading…</Empty></Scroll>;
  if (v === undefined) return <Scroll><Empty title="Not a version of this file"><Button variant="outline" onClick={() => go(null)}>Back to the file</Button></Empty></Scroll>;
  const [older, newer] = [list[at + 1], list[at - 1]];
  return (
    <div className="flex min-h-0 flex-auto flex-col">
      <div className="flex h-11 flex-none items-center gap-1 border-b border-sunken px-3 text-[12.5px] text-ink-3" role="status">
        <Button variant="ghost" size="icon-sm" aria-label="The change before" title="The change before" disabled={older === undefined} onClick={() => go(older?.commit ?? null)}><Icon name="prev" size={15} /></Button>
        <Button variant="ghost" size="icon-sm" aria-label="The change after" title="The change after" disabled={newer === undefined} onClick={() => go(newer?.commit ?? null)}><Icon name="next" size={15} /></Button>
        <span className="ml-1.5 min-w-0 truncate">
          <b className="font-bold text-ink">{`Changed ${when(v.at)}`}</b>
          {` · ${saidOf(v)} · ${v.author}`}
          {v.add === null ? null : <>{' · '}<span className="text-success">{`+${v.add}`}</span>{' '}<span className="text-destructive">{`−${v.del}`}</span></>}
          {at === 0 ? ' · the latest' : ` · ${at} ${at === 1 ? 'change' : 'changes'} ago`}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto" onClick={() => go(null)}>Back to the file</Button>
      </div>
      <Scroll>
        {v.sha === null ? <Empty title="Deleted here">This change took the file out of the task.</Empty>
          : rendered === null ? <Empty>{now.isError ? <span className="text-destructive">{String(now.error.message)}</span> : 'Loading…'}</Empty>
          : (
            <div className="mx-auto max-w-[840px] px-10 pt-8 pb-20">
              {rendered.changed === 0 ? <p className="mb-6 text-[13px] text-ink-3">Nothing in how it reads changed here: only its spacing, or how its source is written.</p> : null}
              <div ref={doc} className={cn(DOC, DIFFED)} dangerouslySetInnerHTML={{ __html: rendered.html }} />
            </div>
          )}
      </Scroll>
    </div>
  );
}
