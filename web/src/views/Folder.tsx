import { useEffect, useRef, useState, type ReactNode } from 'react';
import { looksBinary, type ArtifactFile, type TaskDetail } from '../lib/api';
import { badge, baseName, buildTree, dirName, kindOf, sortedDirs, sortedFiles, treeOrder, viewerOf, type TreeNode } from '../lib/files';
import { plural } from '../lib/format';
import { link } from '../lib/route';
import { unseenOf } from '../lib/seen';
import { cn } from '../lib/utils';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui/button';
import { Bar, BarTools, Crumb, Dot, Empty, Scroll } from '../components/page';
import { shaUrl, thumbUrl, useIndex, useText } from '../state/server';
import { useUI } from '../state/ui';
import { useKeyNav } from './nav';

/** A card: its well, and its name under it. The well's edge turns teal while the card is pointed at. */
const CARD = 'group/card flex min-w-0 flex-col gap-1.5 text-ink';
const WELL = 'relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-[10px] bg-[var(--well)] ring-1 ring-border group-hover/card:ring-2 group-hover/card:ring-brand';
const CAP = 'flex min-w-0 items-center gap-1.5 text-[13px]/[18px]';
/** A picture or a video's first frame fills the well, whole, on the dark a thumbnail sits on. */
const PICTURE = 'size-full bg-[var(--thumb-well)] object-contain';
/** A file with nothing to show, its kind in the middle of the well. */
const KIND = 'rounded-[6px] bg-card px-2 py-1 font-mono text-[13px] leading-[normal] font-bold text-ink-3';
/** The kind of a file that shows something, small in the well's corner. */
const CORNER = 'absolute right-2 bottom-2 rounded-[5px] bg-sunken px-1.5 py-px font-mono text-[10px]/4 font-bold text-ink-3';

/** A text file's card shows its first lines, read once the card scrolls near; they fade out towards the card's foot. */
function Preview({ sha }: { sha: string }) {
  const ref = useRef<HTMLPreElement>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const watch = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setNear(true);
        watch.disconnect();
      }
    }, { rootMargin: '300px' });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const text = useText(near ? `/blob/${sha}` : null);
  const lines = text.data === undefined || looksBinary(text.data) ? '' : text.data.split('\n').slice(0, 26).map((l) => l.slice(0, 140)).join('\n');
  return (
    <pre ref={ref} className="absolute inset-0 m-0 overflow-hidden bg-card px-3 py-2.5 font-mono text-[9.5px]/[13px] whitespace-pre text-ink-2 [mask-image:linear-gradient(#000_70%,transparent)]">
      {lines}
    </pre>
  );
}

function Well({ f, name }: { f: ArtifactFile; name: string }): ReactNode {
  if (kindOf(name) === 'image') return <img className={PICTURE} src={thumbUrl(f.sha, name, 'card')} alt="" loading="lazy" decoding="async" />;
  const v = viewerOf(name);
  // The first frame, which the browser fetches by range without playing anything.
  if (v === 'video') return <><video className={PICTURE} src={`${shaUrl(f.sha, name)}#t=0.1`} muted preload="metadata" playsInline /><span className={CORNER}>{badge(name)}</span></>;
  if ((v === 'text' || v === 'markdown') && !(f.size > 400000)) return <><Preview sha={f.sha} /><span className={CORNER}>{badge(name)}</span></>;
  return <span className={KIND}>{badge(name)}</span>;
}

/** A folder of a task's artifacts as a grid of cards: its folders first, each with a picture from inside when it has one. */
export function FolderView({ t, d, path }: { t: { id: string }; d: TaskDetail; path: string }) {
  const seen = useUI((s) => s.seen);
  const { data: index } = useIndex();
  useKeyNav(null, null);
  let node: TreeNode<ArtifactFile> | undefined = buildTree(d.files);
  for (const part of path ? path.split('/') : []) node = node?.dirs.get(part);
  if (!node) return <Empty title="Nothing here">{`${path}/ has no files.`}</Empty>;
  const unseen = index && seen ? unseenOf(index, seen, t.id) : new Map();
  return (
    <>
      <Bar
        title={path ? <Crumb path={path} /> : 'Artifacts'}
        meta={plural(node.count, 'file')}
        tools={path ? <BarTools><Button variant="ghost" size="sm" nativeButton={false} render={<a href={link.folder(t.id, dirName(path))} />}><Icon name="prev" size={16} />Up</Button></BarTools> : null} />
      <Scroll>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] gap-3.5 px-6 pt-[22px] pb-[60px]">
          {sortedDirs(node).map((dir) => {
            const cover = treeOrder(dir).find((f) => kindOf(f.path) === 'image');
            return (
              <a key={`d:${dir.path}`} className={CARD} href={link.folder(t.id, dir.path)}>
                <span className={WELL}>
                  {cover ? <img className={PICTURE} src={thumbUrl(cover.sha, baseName(cover.path), 'card')} alt="" loading="lazy" decoding="async" /> : <span className={KIND}><Icon name="folder" size={22} /></span>}
                  {/* Over a picture, the count is white with a shadow, to be read on whatever the picture is. */}
                  <span className={cn('absolute right-2 bottom-2 text-[12px] text-ink-3', cover && 'text-white [text-shadow:0_1px_2px_#000]')}>{plural(dir.count, 'file')}</span>
                </span>
                <span className={CAP}><span className="flex flex-none text-ink-3"><Icon name="folder" size={14} /></span><span className="truncate">{dir.name}</span></span>
              </a>
            );
          })}
          {sortedFiles(node).map((f) => {
            const name = baseName(f.path);
            return (
              <a key={`f:${f.path}`} className={CARD} href={link.file(t.id, f.path)} title={f.path}>
                <span className={WELL}><Well f={f} name={name} /></span>
                <span className={CAP}>{unseen.has(f.path) ? <Dot title="new since your last look" /> : null}<span className="truncate">{name}</span></span>
              </a>
            );
          })}
        </div>
      </Scroll>
    </>
  );
}
