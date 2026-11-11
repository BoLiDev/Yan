import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArtifactFile } from '../../lib/api';
import { dirName } from '../../lib/files';
import { plural, when } from '../../lib/format';
import { langReady } from '../../lib/highlight';
import { renderMarkdownDiff } from '../../lib/markdownDiff';
import { cn } from '../../lib/utils';
import { Icon } from '../../components/Icon';
import { Empty, Scroll, Seg } from '../../components/page';
import { ReviewMenu } from '../../components/review/ReviewMenu';
import { inChange } from '../../components/review/locate';
import { Button } from '../../components/ui/button';
import { filesOrigin, useTask, useText } from '../../state/server';
import { setPref, useUI } from '../../state/ui';
import { DOC } from '../doc';
import { saidOf, useHistory } from './history';
import { useSpots } from './spots';

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
  // The place being looked at, of those the change touched (`useSpots`): ringed, a row side by side as one.
  '[&_[data-current]]:rounded-[10px] [&_[data-current]]:outline-2 [&_[data-current]]:outline-offset-4 [&_[data-current]]:outline-brand/45',
  '[&_ins]:rounded-[3px] [&_ins]:bg-[var(--diff-add-word)] [&_ins]:no-underline',
  '[&_del]:rounded-[3px] [&_del]:bg-[var(--diff-del-word)] [&_del]:text-ink-3 [&_del]:decoration-[color:var(--red)]/60',
].join(' ');

/**
 * The two versions side by side, as `renderMarkdownDiff` lays them out
 * with `split`: a row to a block, the old in the left half and the new in
 * the right, a line down the middle, each half narrow enough that what is
 * wide in it, a table or a fence, scrolls on its own.
 */
const SPLIT = [
  '[&_[data-row]]:grid [&_[data-row]]:grid-cols-2',
  '[&_[data-side]]:min-w-0 [&_[data-side=old]]:pr-8 [&_[data-side=new]]:border-l [&_[data-side=new]]:border-sunken [&_[data-side=new]]:pl-8',
].join(' ');

/**
 * What one version of a Markdown file changed of the one before it, drawn
 * as the document: the text as that version had it, with what it added,
 * took out and reworded marked in it, opened at the first of them, the
 * others a step away each, by the arrows over it or J and K; or, side
 * by side, the version before on the left and this one on the right. Over it,
 * which version it is, the ways to the one before and the one after, and
 * the way back to the file as it is. What is selected in it is commented
 * on from a right click, as in the file, into the task's review. An agent and `user` both write these
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
  const split = useUI((s) => s.prefs.history === 'split');
  const ready = v !== undefined && now.data !== undefined && (v.before === null || was.data !== undefined);
  const rendered = useMemo(
    () => (ready ? renderMarkdownDiff(v.before === null ? null : was.data ?? '', now.data ?? '', { task, dir: dirName(`artifacts/${file.path}`), files, filesOrigin: filesOrigin() }, split) : null),
    // `loaded` stands for the languages highlight.js has loaded, which the rendering reads: one arriving makes it again.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [ready, v, was.data, now.data, task, file.path, files, split, loaded],
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
  // Side by side a place is a row, the old and the new of it together.
  const spots = useSpots(doc, split ? '[data-row]:has([data-diff])' : '[data-diff]', html);

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
        <span className="ml-auto flex flex-none items-center gap-1">
          {spots.total > 0 ? (
            <span className="mr-1 flex items-center" role="group" aria-label="Places changed">
              <Button variant="ghost" size="icon-sm" aria-label="The place changed before this one" title="The place changed before (K)" onClick={() => spots.step(-1)}><Icon name="up" size={15} /></Button>
              <span className="min-w-[44px] text-center tabular-nums" aria-live="polite">{`${spots.at + 1} / ${spots.total}`}</span>
              <Button variant="ghost" size="icon-sm" aria-label="The next place changed" title="The next place changed (J)" onClick={() => spots.step(1)}><Icon name="down" size={15} /></Button>
            </span>
          ) : null}
          <Seg options={[['inline', 'Inline'], ['split', 'Side by side']] as const} current={split ? 'split' : 'inline'} onPick={(how) => setPref('history', how)} />
          <Button variant="ghost" size="sm" onClick={() => go(null)}>Back to the file</Button>
        </span>
      </div>
      <Scroll>
        {v.sha === null ? <Empty title="Deleted here">This change took the file out of the task.</Empty>
          : rendered === null ? <Empty>{now.isError ? <span className="text-destructive">{String(now.error.message)}</span> : 'Loading…'}</Empty>
          : (
            <div className={cn('mx-auto px-10 pt-8 pb-20', split ? 'max-w-[1360px]' : 'max-w-[840px]')}>
              {rendered.changed === 0 ? <p className="mb-6 text-[13px] text-ink-3">Nothing in how it reads changed here: only its spacing, or how its source is written.</p> : null}
              {split ? (
                <div className="mb-4 grid grid-cols-2 text-[12px] font-bold text-ink-3">
                  <span>Before</span>
                  <span className="pl-8">After</span>
                </div>
              ) : null}
              {/* Commented on as the file is, the comment saying which change it was read in. */}
              <ReviewMenu task={task} locate={(range) => inChange(`artifacts/${file.path}`, v.commit, v.at, range)}>
                <div ref={doc} className={cn(DOC, DIFFED, split && SPLIT)} dangerouslySetInnerHTML={{ __html: rendered.html }} />
              </ReviewMenu>
            </div>
          )}
      </Scroll>
    </div>
  );
}
