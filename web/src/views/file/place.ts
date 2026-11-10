import { useEffect, useLayoutEffect, useRef } from 'react';
import { keepSpot, spotIn } from './reading';

/**
 * Where a Markdown file is being read, and putting it there: the line of its
 * source at the top of the view, with how far into that line, as a
 * fraction. The rendered text carries a mark before each of its blocks
 * saying the line the block begins on (`renderMarkdown`'s `lines`), and a
 * place inside a block is reckoned in proportion, between its mark and the
 * next; the source is measured by laying its text out as its box lays it
 * out, lines wrapped as they wrap there. Where each file was read is kept
 * by `reading.ts`.
 */

/** The marks in a rendered text, with where each is from the top of what scrolls: content coordinates. */
function marksIn(scroller: HTMLElement): { line: number; top: number }[] {
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  return [...scroller.querySelectorAll<HTMLElement>('[data-line]')].map((m) => ({ line: Number(m.dataset.line), top: m.getBoundingClientRect().top - base }));
}

/** The marks, with the end of the text after them, at its last line. */
function spans(scroller: HTMLElement, lines: number): { line: number; top: number }[] {
  const marks = marksIn(scroller);
  return marks.length === 0 ? [] : [...marks, { line: lines, top: scroller.scrollHeight }];
}

/** The line of the source at the top of a rendered text, or null when it has no marks. */
export function renderedLine(scroller: HTMLElement, lines: number): number | null {
  const all = spans(scroller, lines);
  if (all.length === 0) return null;
  const y = scroller.scrollTop;
  let i = 0;
  while (i + 1 < all.length - 1 && (all[i + 1] as { top: number }).top <= y) i++;
  const [a, b] = [all[i] as { line: number; top: number }, all[i + 1] as { line: number; top: number }];
  const into = b.top > a.top ? Math.min(1, Math.max(0, (y - a.top) / (b.top - a.top))) : 0;
  return a.line + into * (b.line - a.line);
}

/** Where in a rendered text the source's `line` is, from the top of what scrolls, or null when it has no marks. */
function renderedY(scroller: HTMLElement, line: number, lines: number): number | null {
  const all = spans(scroller, lines);
  if (all.length === 0) return null;
  let i = 0;
  while (i + 1 < all.length - 1 && (all[i + 1] as { line: number }).line <= line) i++;
  const [a, b] = [all[i] as { line: number; top: number }, all[i + 1] as { line: number; top: number }];
  const into = b.line > a.line ? Math.min(1, Math.max(0, (line - a.line) / (b.line - a.line))) : 0;
  return a.top + into * (b.top - a.top);
}

/**
 * Scroll a rendered text to the source's `line`, and keep it there while
 * what is above it settles, pictures loading and code being coloured, until
 * the reader moves it or a moment has passed. Returns what lets it go.
 */
export function holdRenderedAt(scroller: HTMLElement, line: number, lines: number): () => void {
  const put = (): void => {
    const y = renderedY(scroller, line, lines);
    if (y !== null) scroller.scrollTop = y;
  };
  put();
  const sizes = new ResizeObserver(put);
  for (const child of scroller.children) sizes.observe(child);
  const moved = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
  const stop = (): void => {
    sizes.disconnect();
    clearTimeout(timer);
    for (const e of moved) scroller.removeEventListener(e, stop);
  };
  for (const e of moved) scroller.addEventListener(e, stop, { passive: true });
  const timer = setTimeout(stop, 1500);
  return stop;
}

/**
 * A text box's text laid out as the box lays it out, out of sight: the top
 * of each line is read off it, its wrapped lines counted in.
 */
function measurer(area: HTMLTextAreaElement): { top: (line: number) => number; done: () => void } {
  const style = getComputedStyle(area);
  const mirror = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing', 'lineHeight', 'tabSize', 'textIndent', 'textTransform', 'whiteSpace', 'overflowWrap', 'wordBreak', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const) {
    mirror.style[p] = style[p];
  }
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', left: '-99999px', top: '0', boxSizing: 'border-box', border: '0', width: `${area.clientWidth}px`, height: 'auto', overflow: 'hidden' });
  document.body.append(mirror);
  const lines = area.value.split('\n');
  const tops = new Map<number, number>();
  const top = (line: number): number => {
    const n = Math.max(0, Math.min(line, lines.length));
    const known = tops.get(n);
    if (known !== undefined) return known;
    mirror.textContent = n === 0 ? '' : `${lines.slice(0, n).join('\n')}\n`;
    const at = document.createElement('span');
    at.textContent = '​';
    mirror.append(at);
    const y = at.offsetTop;
    tops.set(n, y);
    return y;
  };
  return { top, done: () => mirror.remove() };
}

/** The line of the source at the top of its box. */
export function sourceLine(area: HTMLTextAreaElement): number {
  const m = measurer(area);
  try {
    const pad = Number.parseFloat(getComputedStyle(area).paddingTop) || 0;
    const y = area.scrollTop + pad;
    const n = area.value.split('\n').length;
    // The last line whose top is at or above the box's: found by halves, each a layout of the text up to it.
    let [lo, hi] = [0, n - 1];
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (m.top(mid) <= y) lo = mid;
      else hi = mid - 1;
    }
    const [a, b] = [m.top(lo), m.top(lo + 1)];
    return lo + (b > a ? Math.min(1, Math.max(0, (y - a) / (b - a))) : 0);
  } finally {
    m.done();
  }
}

/** Scroll a source's box to its `line`. */
export function scrollSourceTo(area: HTMLTextAreaElement, line: number): void {
  const m = measurer(area);
  try {
    const pad = Number.parseFloat(getComputedStyle(area).paddingTop) || 0;
    const whole = Math.floor(line);
    const [a, b] = [m.top(whole), m.top(whole + 1)];
    area.scrollTop = a + (line - whole) * (b - a) - pad;
  } finally {
    m.done();
  }
}

/**
 * A view of the Markdown file at `path`, Rendered or Source, keeping its
 * place: as it is read, where it is (`read`) is noted for the file; once it
 * is `ready`, and whenever `anchor`, the text it shows, is changed under it,
 * by an agent's push, it is put back where the file was being read (`go`),
 * in whichever view, before another file was opened, before the page was
 * reloaded, or before the change. An `anchor` of undefined holds it where it
 * is: what is typed in it moves nothing.
 */
export function useReadingPlace(path: string, ready: boolean, anchor: string | undefined, view: { el: () => HTMLElement | null; text: () => string | undefined; read: () => number | null; go: (line: number) => (() => void) | void }): void {
  const latest = useRef(view);
  useLayoutEffect(() => {
    latest.current = view;
  });
  useLayoutEffect(() => {
    if (anchor === undefined) return;
    const line = spotIn(path, anchor);
    if (line === null) return;
    return latest.current.go(line) ?? undefined;
  }, [path, anchor]);
  useEffect(() => {
    const el = latest.current.el();
    if (!ready || el === null) return;
    const note = (): void => {
      const [line, text] = [latest.current.read(), latest.current.text()];
      if (line !== null && text !== undefined) keepSpot(path, text, line);
    };
    // Once a frame at most, however fast it is scrolled.
    let frame = 0;
    const scrolled = (): void => {
      if (frame === 0) frame = requestAnimationFrame(() => {
        frame = 0;
        note();
      });
    };
    el.addEventListener('scroll', scrolled, { passive: true });
    return () => {
      el.removeEventListener('scroll', scrolled);
      // A scroll not yet noted, as the view is swapped or left: noted while the view is still there to say where it is.
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        if (el.isConnected) note();
      }
    };
  }, [path, ready]);
}
