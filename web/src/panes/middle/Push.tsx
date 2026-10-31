import type { Push, PushFile } from '../../lib/api';
import { badge, baseName, dirName } from '../../lib/files';
import { clock } from '../../lib/format';
import { link, type Route } from '../../lib/route';
import type { Unseen } from '../../lib/seen';
import { Icon } from '../../components/Icon';
import { Dot, GROW, KIND, PushTags, Tool, row } from '../../components/page';
import { cn } from '../../lib/utils';
import { useUI } from '../../state/ui';
import { FileThumb } from '../Tree';

type LatestRoute = Extract<Route, { view: 'latest' }>;

/** A file of a push, a little in under the line that opened it. */
const FILE_ROW = 'gap-[9px] rounded-md py-1 pr-2.5 pl-[25px] text-[13.5px]';
/** What became of a file in a push, as a tag at its end. */
const TAG = 'flex-none rounded-full px-[7px] text-[11.5px]/[18px] font-normal';

/**
 * A push in Latest: a line saying when, which task, and how many files it
 * added, changed and deleted, which opens to its files; `holding` is the
 * push that holds the file being shown, which is open.
 */
export function PushItem({ p, title, holding, r, unseen }: { p: Push; title: string; holding: boolean; r: LatestRoute; unseen: Unseen | undefined }) {
  const key = `${p.task}@${p.at}`;
  const open = useUI((s) => s.feedOpen.includes(key)) || holding;
  const toggle = (): void => {
    useUI.setState((s) => ({ feedOpen: open ? s.feedOpen.filter((k) => k !== key) : [...s.feedOpen, key] }));
    if (holding && open) location.hash = '#/latest';
  };
  return (
    <div className="flex flex-col gap-px py-px">
      {/* The arrow sits beside the line, not in it: a link cannot sit inside the button that opens the files. The line is the card. */}
      <div className="flex items-center gap-0.5 rounded-md has-[>button:hover]:bg-hover">
        <button type="button" aria-expanded={open} title={`${title} · ${p.task}`} onClick={toggle}
          className="flex min-h-8 w-full min-w-0 flex-auto cursor-pointer items-center gap-2 rounded-md py-1 pr-2.5 pl-1.5 text-left text-[13px] text-ink-2 focus-visible:-outline-offset-2">
          <span className={cn('flex flex-none text-ink-3 transition-transform duration-120', open && 'rotate-90')}><Icon name="chev" size={14} /></span>
          <b className="flex-none text-foreground tabular-nums">{clock(p.at)}</b>
          <span className={GROW}>{title}</span>
          <span className="flex flex-none gap-1"><PushTags files={p.files} /></span>
        </button>
        <Tool name="go" label="Open the task" href={link.task(p.task)} newTab={false} small />
      </div>
      {open ? p.files.map((f) => <PushedFile key={f.path} f={f} task={p.task} on={r.id === p.task && r.path === f.path && holding} fresh={!!unseen?.has(f.path)} />) : null}
    </div>
  );
}

/** One file of an open push: it opens on the right, unless it was deleted and there is nothing left to show. */
function PushedFile({ f, task, on, fresh }: { f: PushFile; task: string; on: boolean; fresh: boolean }) {
  const name = baseName(f.path);
  const gone = f.status === 'D';
  const where = <span className={cn(GROW, gone && 'line-through')}><span className="text-ink-3">{dirName(f.path) ? dirName(f.path) + '/' : ''}</span>{name}</span>;
  if (gone) {
    return (
      <div className={cn(row(), FILE_ROW, 'cursor-default text-ink-3 hover:text-ink-3')} title={`${task}/${f.path}, deleted`}>
        <span className={KIND}>{badge(name)}</span>{where}<span className={cn(TAG, 'bg-sunken text-ink-3')}>deleted</span>
      </div>
    );
  }
  return (
    <a className={cn(row({ on }), FILE_ROW)} aria-current={on ? 'page' : undefined} href={link.latest(task, f.path)} title={`${task}/${f.path}`}>
      <FileThumb path={f.path} sha={f.sha} />{where}
      {fresh ? <Dot title="new since your last look" /> : null}
      {f.status === 'A' ? <span className={cn(TAG, 'bg-brand-soft text-brand')}>new</span> : null}
    </a>
  );
}
