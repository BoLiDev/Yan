// What a file is, and the tree a list of paths makes.

export type Kind = 'image' | 'page' | 'doc' | 'code' | 'media' | 'font' | 'other';
export type Viewer = 'image' | 'page' | 'markdown' | 'pdf' | 'video' | 'audio' | 'font' | 'text';

const EXT_KIND: Record<string, Kind> = {};
const KINDS: Record<Exclude<Kind, 'other'>, string> = {
  image: 'png jpg jpeg gif webp svg avif bmp ico',
  page: 'html htm',
  doc: 'md markdown txt pdf rst',
  code: 'js mjs cjs ts tsx jsx json jsonl css scss less py sh bash zsh ps1 bat rb go rs java kt swift c h cpp hpp cs yaml yml toml xml sql lua vue svelte diff patch log csv tsv ini env',
  media: 'mp3 wav ogg m4a flac aac mp4 webm mov m4v',
  font: 'woff woff2 ttf otf',
};
for (const [kind, list] of Object.entries(KINDS)) for (const e of list.split(' ')) EXT_KIND[e] = kind as Kind;

export const KIND_LABEL: Record<Kind, string> = { image: 'Images', page: 'Pages', doc: 'Docs', code: 'Code', media: 'Media', font: 'Fonts', other: 'Other' };
export const KIND_ORDER: readonly Kind[] = ['image', 'page', 'doc', 'code', 'media', 'font', 'other'];
export const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v']);
/** Files whose lines are wrapped unless the reader says otherwise. */
export const WRAPPED = new Set(['log', 'txt', 'md', 'markdown', 'jsonl', 'csv', 'tsv', '']);

export const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
export const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function ext(name: string): string {
  const m = /\.([^./]+)$/.exec(name);
  return m ? (m[1] as string).toLowerCase() : '';
}

export const kindOf = (name: string): Kind => EXT_KIND[ext(name)] ?? 'other';

export function badge(name: string): string {
  return (ext(name) || 'file').slice(0, 4).toUpperCase();
}

/** How the right pane shows a file. */
export function viewerOf(name: string): Viewer {
  const e = ext(name);
  const k = kindOf(name);
  if (k === 'image') return 'image';
  if (k === 'page') return 'page';
  if (e === 'md' || e === 'markdown') return 'markdown';
  if (e === 'pdf') return 'pdf';
  if (k === 'media') return VIDEO.has(e) ? 'video' : 'audio';
  if (k === 'font') return 'font';
  return 'text';
}

/**
 * The same screen taken another way: `stage1-1280.png` and `stage1-390.png`,
 * `home-light.png` and `home-dark.png`. Names that differ in one word, both
 * words a width or a look.
 */
const VARIANT = /^(\d{3,4}|desktop|mobile|phone|tablet|ipad|light|dark|wide|narrow|portrait|landscape)$/i;
export function variantsOf(name: string, names: readonly string[]): { name: string; word: string }[] {
  const mine = name.split(/([-_.])/);
  const found: { name: string; word: string }[] = [];
  for (const other of names) {
    if (other === name) continue;
    const theirs = other.split(/([-_.])/);
    if (theirs.length !== mine.length) continue;
    let at = -1;
    let count = 0;
    for (let i = 0; i < mine.length; i++) {
      if (mine[i] !== theirs[i]) {
        count++;
        at = i;
      }
    }
    if (count === 1 && VARIANT.test(mine[at] ?? '') && VARIANT.test(theirs[at] ?? '')) found.push({ name: other, word: theirs[at] as string });
  }
  return found;
}

/** A path in a URL, each part encoded and the slashes kept. */
export const enc = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

/** `rel` from the folder `dir`, `..` and `.` resolved. */
export function resolveRel(dir: string, rel: string): string {
  const out = dir ? dir.split('/') : [];
  for (const part of rel.split('/')) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

// ── the tree ───────────────────────────────────────────────────────────────

export interface TreeFile {
  readonly path: string;
}

export interface TreeNode<F extends TreeFile> {
  readonly name: string;
  readonly path: string;
  readonly dirs: Map<string, TreeNode<F>>;
  readonly files: F[];
  count: number;
}

export function buildTree<F extends TreeFile>(files: readonly F[]): TreeNode<F> {
  const root: TreeNode<F> = { name: '', path: '', dirs: new Map(), files: [], count: 0 };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    node.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i] as string;
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [], count: 0 };
        node.dirs.set(part, next);
      }
      node = next;
      node.count++;
    }
    node.files.push(f);
  }
  return root;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const sortedDirs = <F extends TreeFile>(node: TreeNode<F>): TreeNode<F>[] => [...node.dirs.values()].sort((a, b) => collator.compare(a.name, b.name));
export const sortedFiles = <F extends TreeFile>(node: TreeNode<F>): F[] => [...node.files].sort((a, b) => collator.compare(baseName(a.path), baseName(b.path)));

/** Every file in tree order: what prev and next walk. */
export function treeOrder<F extends TreeFile>(node: TreeNode<F>, out: F[] = []): F[] {
  for (const d of sortedDirs(node)) treeOrder(d, out);
  for (const f of sortedFiles(node)) out.push(f);
  return out;
}

/** A folder that holds only one folder is shown as one row with it, so a long path stays shallow. */
export function compactDir<F extends TreeFile>(dir: TreeNode<F>): { name: string; dir: TreeNode<F> } {
  let name = dir.name;
  let at = dir;
  while (!at.files.length && at.dirs.size === 1) {
    at = at.dirs.values().next().value as TreeNode<F>;
    name += '/' + at.name;
  }
  return { name, dir: at };
}

export function kindCounts(files: readonly TreeFile[]): Partial<Record<Kind, number>> {
  const counts: Partial<Record<Kind, number>> = {};
  for (const f of files) {
    const k = kindOf(f.path);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/** Every folder above `path`, nearest first. */
export function foldersAbove(path: string): string[] {
  const out: string[] = [];
  for (let p = dirName(path); p; p = dirName(p)) out.push(p);
  return out;
}

/** A task's artifacts, all of them or those of one kind. */
export function shownFiles<F extends TreeFile>(files: readonly F[], kind: Kind | 'all'): readonly F[] {
  return kind === 'all' ? files : files.filter((f) => kindOf(f.path) === kind);
}

const orders = new WeakMap<object, readonly TreeFile[]>();
/** A branch's changed files in the order its tree shows them, which prev and next walk; worked out once per answer. */
export function changeOrder<F extends TreeFile>(b: { readonly files: readonly F[] }): readonly F[] {
  let order = orders.get(b) as readonly F[] | undefined;
  if (!order) {
    order = treeOrder(buildTree(b.files));
    orders.set(b, order);
  }
  return order;
}
