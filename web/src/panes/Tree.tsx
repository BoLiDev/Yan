import type { ReactNode } from 'react';
import { badge, baseName, compactDir, kindOf, sortedDirs, sortedFiles, type TreeFile, type TreeNode } from '../lib/files';
import { Icon } from '../components/Icon';
import { shaUrl } from '../state/server';

export interface TreeOptions<F extends TreeFile> {
  isOpen: (path: string) => boolean;
  setOpen: (path: string, open: boolean) => void;
  /** The file and the folder being shown, marked as such. */
  file: string | null;
  folder: string | null;
  fileHref: (path: string) => string;
  /** A folder row opens its folder's page when there is this, and only opens and closes otherwise. */
  folderHref?: (path: string) => string;
  isNew?: (f: F) => boolean;
  /** A dot on a closed folder with something new inside, where it would otherwise be found by nobody. */
  newIn?: (path: string) => boolean;
  /** A picture's thumbnail beside its name; off, every file gets its badge. */
  thumbs?: boolean;
  /** A folder that holds only one folder shares its row. */
  compact?: boolean;
  /** How far each level is indented. */
  step?: number;
  tip?: (f: F) => string;
  lead?: (f: F) => ReactNode;
  extra?: (f: F) => ReactNode;
}

export function FileThumb({ path, sha }: { path: string; sha?: string }) {
  const name = baseName(path);
  if (sha && kindOf(name) === 'image') return <img className="thumb" src={shaUrl(sha, name)} alt="" loading="lazy" decoding="async" />;
  return <span className="kind">{badge(name)}</span>;
}

/** The rows of a tree, folders first, each level indented under the one that holds it. */
export function TreeRows<F extends TreeFile & { readonly sha?: string }>({ node, options }: { node: TreeNode<F>; options: TreeOptions<F> }) {
  const out: ReactNode[] = [];
  rows(node, 0, options, out);
  return <>{out}</>;
}

function rows<F extends TreeFile & { readonly sha?: string }>(node: TreeNode<F>, depth: number, o: TreeOptions<F>, out: ReactNode[]): void {
  const step = o.step ?? 16;
  for (const top of sortedDirs(node)) {
    const { name, dir } = o.compact ? compactDir(top) : { name: top.name, dir: top };
    const open = o.isOpen(dir.path);
    const current = o.folder === dir.path;
    out.push(
      <a key={`d:${dir.path}`} className={'row folder' + (open ? ' open' : '') + (current ? ' on' : '')}
        href={o.folderHref ? o.folderHref(dir.path) : undefined} style={{ paddingLeft: `${10 + depth * step}px` }}
        role="treeitem" aria-expanded={open} title={dir.path}
        onClick={() => {
          if (!o.folderHref) o.setOpen(dir.path, !open);
          else if (open && current) o.setOpen(dir.path, false);
          else o.setOpen(dir.path, true);
        }}>
        <span className="chev" role="button" aria-label={open ? 'Close the folder' : 'Open the folder'} onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          o.setOpen(dir.path, !open);
        }}><Icon name="chev" size={12} width={2.25} /></span>
        <span className="folder-icon"><Icon name="folder" size={15} /></span>
        <span className="grow">{name}</span>
        {o.newIn?.(dir.path) ? <span className="dot" title="something new inside" /> : null}
        <span className="aside">{dir.count}</span>
      </a>,
    );
    if (open) rows(dir, depth + 1, o, out);
  }
  for (const f of sortedFiles(node)) {
    const name = baseName(f.path);
    const on = o.file === f.path;
    out.push(
      <a key={`f:${f.path}`} className={'row' + (on ? ' on' : '')} href={o.fileHref(f.path)} style={{ paddingLeft: `${32 + depth * step}px` }}
        role="treeitem" aria-selected={on} title={o.tip ? o.tip(f) : f.path}>
        {o.lead ? o.lead(f) : o.thumbs === false ? <span className="kind">{badge(name)}</span> : <FileThumb path={f.path} sha={f.sha} />}
        <span className="grow" style={{ fontWeight: on ? 700 : 400 }}>{name}</span>
        {o.isNew?.(f) ? <span className="dot" title="new since your last look" /> : null}
        {o.extra ? o.extra(f) : null}
      </a>,
    );
  }
}
