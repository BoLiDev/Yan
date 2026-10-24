import { useEffect, useRef, useState, type ReactNode } from 'react';
import { looksBinary, type ArtifactFile, type TaskDetail } from '../lib/api';
import { KIND_LABEL, badge, baseName, buildTree, dirName, kindOf, shownFiles, sortedDirs, sortedFiles, treeOrder, viewerOf, type TreeNode } from '../lib/files';
import { plural } from '../lib/format';
import { link } from '../lib/route';
import { unseenOf } from '../lib/seen';
import { Icon } from '../components/Icon';
import { Bar, Crumb, Empty } from '../components/ui';
import { shaUrl, thumbUrl, useIndex, useText } from '../state/server';
import { useUI } from '../state/ui';
import { useKeyNav } from './nav';

/** A text file's card shows its first lines, read once the card scrolls near. */
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
  return <pre className="preview" ref={ref}>{lines}</pre>;
}

function Well({ f, name }: { f: ArtifactFile; name: string }): ReactNode {
  if (kindOf(name) === 'image') return <img src={thumbUrl(f.sha, name, 'card')} alt="" loading="lazy" decoding="async" />;
  const v = viewerOf(name);
  // The first frame, which the browser fetches by range without playing anything.
  if (v === 'video') return <><video src={`${shaUrl(f.sha, name)}#t=0.1`} muted preload="metadata" playsInline /><span className="corner-kind">{badge(name)}</span></>;
  if ((v === 'text' || v === 'markdown') && !(f.size > 400000)) return <><Preview sha={f.sha} /><span className="corner-kind">{badge(name)}</span></>;
  return <span className="big-kind">{badge(name)}</span>;
}

/** A folder of a task's artifacts as a grid of cards: its folders first, each with a picture from inside when it has one. */
export function FolderView({ t, d, path }: { t: { id: string }; d: TaskDetail; path: string }) {
  const filter = useUI((s) => s.filter[t.id] ?? 'all');
  const seen = useUI((s) => s.seen);
  const { data: index } = useIndex();
  useKeyNav(null, null);
  const files = shownFiles(d.files, filter);
  let node: TreeNode<ArtifactFile> | undefined = buildTree(files);
  for (const part of path ? path.split('/') : []) node = node?.dirs.get(part);
  if (!node) return <Empty title="Nothing here">{`${path}/ has no files${filter === 'all' ? '' : ' of this kind'}.`}</Empty>;
  const unseen = index && seen ? unseenOf(index, seen, t.id) : new Map();
  return (
    <>
      <Bar
        title={path ? <Crumb path={path} /> : 'Artifacts'}
        meta={`${plural(node.count, 'file')}${filter === 'all' ? '' : ` · ${KIND_LABEL[filter].toLowerCase()} only`}`}
        tools={path ? <div className="group-tools"><a className="tool text" href={link.folder(t.id, dirName(path))}><Icon name="prev" size={16} />Up</a></div> : null} />
      <div className="scroll">
        <div className="gallery">
          {sortedDirs(node).map((dir) => {
            const cover = treeOrder(dir).find((f) => kindOf(f.path) === 'image');
            return (
              <a key={`d:${dir.path}`} className="card" href={link.folder(t.id, dir.path)}>
                <span className="well">
                  {cover ? <img src={thumbUrl(cover.sha, baseName(cover.path), 'card')} alt="" loading="lazy" decoding="async" /> : <span className="big-kind"><Icon name="folder" size={22} /></span>}
                  <span className="folder-n" style={cover ? { color: '#fff', textShadow: '0 1px 2px #000' } : {}}>{plural(dir.count, 'file')}</span>
                </span>
                <span className="cap"><span className="dim" style={{ display: 'flex' }}><Icon name="folder" size={14} /></span><span>{dir.name}</span></span>
              </a>
            );
          })}
          {sortedFiles(node).map((f) => {
            const name = baseName(f.path);
            return (
              <a key={`f:${f.path}`} className="card" href={link.file(t.id, f.path)} title={f.path}>
                <span className="well"><Well f={f} name={name} /></span>
                <span className="cap">{unseen.has(f.path) ? <span className="dot" /> : null}<span>{name}</span></span>
              </a>
            );
          })}
        </div>
      </div>
    </>
  );
}
