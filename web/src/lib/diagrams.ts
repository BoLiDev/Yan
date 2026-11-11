import { useLayoutEffect, type RefObject } from 'react';
import { useTheme } from '../state/theme';

/**
 * Mermaid in Markdown: a fence that names `mermaid` is drawn as the diagram
 * it describes. Markdown is made into HTML at once and put in place whole,
 * and a diagram is drawn by a library far larger than the rest of the page
 * that takes its time over it, so the diagrams are drawn after: each such
 * fence found in what was put in place is replaced by its drawing, the
 * library loaded the first time one is met. One that cannot be drawn stays
 * as its source, with why said over it. A drawing is kept by its source,
 * so the same text put in place again, as it is whenever anything about it
 * changes, shows its diagrams at once and not a moment later.
 *
 * The source is an agent's, and so not trusted: mermaid draws it `strict`,
 * its text as text and nothing in it to click or run.
 */

type Mermaid = (typeof import('mermaid'))['default'];

let library: Promise<Mermaid> | undefined;
let themed: string | undefined;
let made = 0;
/** Drawings by `<theme>\n<source>`. */
const drawings = new Map<string, string>();
/** What each drawing on the page was drawn from, to draw it again when the theme changes. */
const sources = new WeakMap<Element, string>();

/** The fences to draw in a piece of the page, as marked writes them. */
const FENCES = 'pre > code.language-mermaid';

async function draw(source: string, theme: 'light' | 'dark'): Promise<string> {
  const key = `${theme}\n${source}`;
  const kept = drawings.get(key);
  if (kept !== undefined) return kept;
  const mermaid = await (library ??= import('mermaid').then((m) => m.default));
  if (themed !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: theme === 'dark' ? 'dark' : 'neutral', fontFamily: 'inherit' });
    themed = theme;
  }
  const { svg } = await mermaid.render(`yan-diagram-${++made}`, source);
  drawings.set(key, svg);
  return svg;
}

/** A drawing in the page, in place of `old`: the fence it was written as, or the drawing before it. */
function put(old: Element, source: string, svg: string): void {
  const figure = document.createElement('div');
  figure.dataset.diagram = '';
  // mermaid's own SVG, made from the source as text.
  figure.innerHTML = svg;
  sources.set(figure, source);
  old.replaceWith(figure);
}

/** Draw every Mermaid fence in `box`, and again whenever what is in it (`html`) or the page's theme changes. */
export function useDiagrams(box: RefObject<HTMLElement | null>, html: string | undefined): void {
  const theme = useTheme();
  useLayoutEffect(() => {
    const el = box.current;
    if (el === null || html === undefined) return;
    let live = true;
    const todo: [Element, string][] = [
      ...[...el.querySelectorAll(FENCES)].map((code): [Element, string] => [code.parentElement as Element, code.textContent ?? '']),
      ...[...el.querySelectorAll('[data-diagram]')].map((fig): [Element, string] => [fig, sources.get(fig) ?? '']),
    ];
    for (const [old, source] of todo) {
      if (source.trim() === '') continue;
      const kept = drawings.get(`${theme}\n${source}`);
      // Drawn before: in place before the page is painted, so nothing is seen to change.
      if (kept !== undefined) put(old, source, kept);
      else {
        void draw(source, theme).then((svg) => {
          if (live && old.isConnected) put(old, source, svg);
        }, (err: unknown) => {
          if (!live || !old.isConnected || old.previousElementSibling?.hasAttribute('data-diagram-error')) return;
          const why = document.createElement('div');
          why.dataset.diagramError = '';
          why.textContent = `Mermaid cannot draw this: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`;
          old.before(why);
        });
      }
    }
    return () => {
      live = false;
    };
  }, [box, html, theme]);
}
