import { marked, type Token, type TokensList } from 'marked';
import { colourLines, langLoaded, langOfFence } from './highlight';
import { resolveRel } from './files';
import { link } from './route';

/**
 * Markdown as the page shows it: marked's HTML minus anything that runs,
 * fenced blocks coloured, links to the task's other files opening here, and
 * every heading given an id for the outline. Built once per text into an
 * HTML string, which the page puts in place and leaves alone until the text
 * changes.
 */

export interface MarkdownContext {
  /** The task the text is in, for its relative links; none for text outside a task. */
  readonly task?: string;
  /** The folder the text is in, from the task's own (`artifacts/c4`, or '' for problem.md). */
  readonly dir?: string;
  /** The task's artifacts, by path from artifacts/: a link to one opens it here. */
  readonly files?: readonly { readonly path: string }[];
  /** Where the vault's files are served from. */
  readonly filesOrigin?: string;
  /** The top-level blocks' sources that were there before: every other block is tinted. */
  readonly before?: ReadonlySet<string> | null;
  /** Leave out a first-level heading that opens the text: the page already has its title. */
  readonly dropTitle?: boolean;
}

export interface Heading {
  readonly id: string;
  readonly text: string;
  readonly level: 1 | 2 | 3;
}

export interface RenderedMarkdown {
  readonly html: string;
  readonly heads: readonly Heading[];
  /** Languages its fenced blocks name that are not loaded yet: render again once they are. */
  readonly waiting: readonly string[];
}

const ALLOWED_URL = /^(https?:|mailto:|#|\/|\.|[^:]*$)/i;

/** What marked writes, minus anything that runs: this page's origin holds the API. */
function sanitize(root: Element): void {
  for (const el of root.querySelectorAll('script, iframe, object, embed, style, link, meta, base, form')) el.remove();
  for (const el of root.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      if (n.startsWith('on') || n === 'srcdoc' || n === 'formaction') el.removeAttribute(attr.name);
      else if ((n === 'href' || n === 'src' || n === 'xlink:href') && !ALLOWED_URL.test(attr.value.trim())) el.removeAttribute(attr.name);
    }
  }
}

/**
 * A bare URL followed by Chinese punctuation, `https://x.dev）。`, comes out
 * of marked with the punctuation inside the link. The link ends at it.
 */
function trimAutolinks(root: Element): void {
  for (const a of root.querySelectorAll('a[href]')) {
    const text = a.textContent ?? '';
    let href = a.getAttribute('href') ?? '';
    try {
      href = decodeURI(href);
    } catch {
      continue;
    }
    // marked writes the punctuation into the href percent-encoded.
    if (text !== href || !/^https?:\/\//.test(text)) continue;
    const cut = text.search(/[）」』，。；：、！？》】]/);
    if (cut <= 0) continue;
    a.textContent = text.slice(0, cut);
    a.setAttribute('href', text.slice(0, cut));
    a.after(document.createTextNode(text.slice(cut)));
  }
}

const encPath = (p: string): string => p.split('/').map(encodeURIComponent).join('/');

/**
 * Relative links point at the task's other files. Images load from the
 * files origin; a link to an artifact opens it here; any other relative
 * link opens the file itself, in a new tab.
 */
function fixLinks(root: Element, ctx: MarkdownContext): void {
  const task = ctx.task;
  if (!task) return;
  const files = ctx.files ?? [];
  const fileUrl = (path: string): string => `${ctx.filesOrigin ?? ''}/${encPath(path)}`;
  const resolve = (url: string): string | null => {
    try {
      return resolveRel(ctx.dir ?? '', decodeURI(url.split(/[?#]/)[0] ?? ''));
    } catch {
      return null;
    }
  };
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src') ?? '';
    if (/^[a-z]+:|^\/\/|^\//i.test(src)) continue;
    const rel = resolve(src);
    if (rel === null) continue;
    img.setAttribute('src', fileUrl(`tasks/${task}/${rel}`));
    img.setAttribute('loading', 'lazy');
  }
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#')) continue;
    if (/^[a-z]+:|^\/\//i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener');
      continue;
    }
    const rel = resolve(href);
    if (rel === null) continue;
    const art = rel.startsWith('artifacts/') ? rel.slice('artifacts/'.length) : null;
    if (art !== null && files.some((f) => f.path === art)) a.setAttribute('href', link.file(task, art));
    else if (art !== null && files.some((f) => f.path.startsWith(art + '/'))) a.setAttribute('href', link.folder(task, art));
    else {
      a.setAttribute('href', fileUrl(`tasks/${task}/${rel}`));
      a.setAttribute('target', '_blank');
    }
  }
}

/** Fenced blocks that name a language, `<pre><code class="language-ts">` as marked writes them. */
function colourBlocks(root: Element, waiting: Set<string>): void {
  for (const code of root.querySelectorAll('pre > code[class*="language-"]')) {
    const lang = langOfFence((/language-(\S+)/.exec(code.className) ?? [])[1]?.toLowerCase());
    if (!lang) continue;
    if (!langLoaded(lang)) {
      waiting.add(lang);
      continue;
    }
    const lines = colourLines(lang, (code.textContent ?? '').replace(/\n$/, ''));
    if (lines) code.innerHTML = lines.join('\n');
  }
}

function slug(text: string, used: Set<string>): string {
  const s = text.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'section';
  let n = s;
  for (let i = 2; used.has(n); i++) n = `${s}-${i}`;
  used.add(n);
  return n;
}

export function renderMarkdown(text: string, ctx: MarkdownContext = {}): RenderedMarkdown {
  const doc = document.createElement('div');
  const tokens: TokensList = marked.lexer(text, { gfm: true });
  // A title line repeats the heading the page already has.
  if (ctx.dropTitle) {
    const first = tokens.findIndex((x) => x.type !== 'space');
    const tok = tokens[first] as (Token & { depth?: number }) | undefined;
    if (first >= 0 && tok?.type === 'heading' && tok.depth === 1) tokens.splice(first, 1);
  }
  if (ctx.before) {
    for (const tok of tokens) {
      const one = Object.assign([tok], { links: tokens.links }) as TokensList;
      const holder = document.createElement('div');
      holder.innerHTML = marked.parser(one, { gfm: true });
      if (tok.type !== 'space' && !ctx.before.has(tok.raw.trim())) {
        holder.className = 'fresh';
        doc.append(holder);
      } else doc.append(...holder.childNodes);
    }
  } else {
    doc.innerHTML = marked.parser(tokens, { gfm: true });
  }
  sanitize(doc);
  const waiting = new Set<string>();
  colourBlocks(doc, waiting);
  trimAutolinks(doc);
  fixLinks(doc, ctx);
  const used = new Set<string>();
  const heads: Heading[] = [];
  for (const el of doc.querySelectorAll('h1, h2, h3')) {
    el.id = slug(el.textContent ?? '', used);
    heads.push({ id: el.id, text: el.textContent ?? '', level: Number(el.tagName.slice(1)) as 1 | 2 | 3 });
  }
  return { html: doc.innerHTML, heads, waiting: [...waiting] };
}

/** The top-level blocks of a text, by their source: what `before` is made of. */
export function blocksOf(text: string): Set<string> {
  return new Set(marked.lexer(text, { gfm: true }).map((x) => x.raw.trim()));
}
