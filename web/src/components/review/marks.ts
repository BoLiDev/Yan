import { useEffect, type RefObject } from 'react';
import type { Kept } from '../../state/review';

/**
 * What has been commented on, marked in the text it is in, so a passage
 * read twice is not commented on twice: drawn with the browser's own
 * highlights, which colour ranges of the text without touching it, so
 * nothing the page drew, or marked put in place whole, is changed. A
 * browser without them marks nothing.
 */

const NAME = 'review';

/**
 * The colour of a mark, the theme's (`--review-mark` in index.css), given
 * to the page here and not in index.css: Tailwind's build does not know
 * `::highlight()` yet, and says so each time it meets one.
 */
let styled = false;
function style(): void {
  if (styled) return;
  styled = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`::highlight(${NAME}) { background-color: var(--review-mark); }`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/** `exact` where it is in `box`'s text, its text nodes end to end as a Range reads them. */
function find(box: Element, exacts: readonly string[]): Range[] {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let all = '';
  const walk = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
    nodes.push(n as Text);
    starts.push(all.length);
    all += (n as Text).data;
  }
  const place = (at: number, end: boolean): [Text, number] | null => {
    // The last node that starts at or before `at`; an end exactly on a node's start is the end of the one before.
    let i = starts.length - 1;
    while (i > 0 && ((starts[i] as number) > at || (end && starts[i] === at))) i--;
    const node = nodes[i];
    return node === undefined ? null : [node, Math.min(node.length, at - (starts[i] as number))];
  };
  const out: Range[] = [];
  for (const exact of exacts) {
    const at = exact === '' ? -1 : all.indexOf(exact);
    if (at < 0) continue;
    const [a, b] = [place(at, false), place(at + exact.length, true)];
    if (a === null || b === null) continue;
    const range = document.createRange();
    range.setStart(...a);
    range.setEnd(...b);
    out.push(range);
  }
  return out;
}

/** Mark, in `box`, what each of `comments` is about, and again whenever what `box` holds is drawn anew. */
export function useReviewMarks(box: RefObject<Element | null>, comments: readonly Kept[]): void {
  useEffect(() => {
    const el = box.current;
    if (el === null || typeof Highlight === 'undefined' || !CSS.highlights) return;
    style();
    const exacts = comments.map((c) => c.exact);
    const mine = new Set<Range>();
    const mark = (): void => {
      const all = CSS.highlights.get(NAME) ?? new Highlight();
      for (const r of mine) all.delete(r);
      mine.clear();
      for (const r of exacts.length ? find(el, exacts) : []) {
        mine.add(r);
        all.add(r);
      }
      CSS.highlights.set(NAME, all);
    };
    mark();
    if (exacts.length === 0) return;
    // A diff draws its lines as they come near, and a Markdown file is put in place again when it changes.
    let timer = 0;
    const watch = new MutationObserver(() => {
      clearTimeout(timer);
      timer = window.setTimeout(mark, 150);
    });
    watch.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      watch.disconnect();
      clearTimeout(timer);
      const all = CSS.highlights.get(NAME);
      for (const r of mine) all?.delete(r);
    };
  }, [box, comments]);
}
