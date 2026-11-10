import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Where a Markdown file was being read, so the view swapped in for it,
 * Rendered for Source or Source for Rendered, opens at the same place: the
 * line of its source at the top of the view, with how far into that line,
 * as a fraction. The rendered text carries a mark before each of its blocks
 * saying the line the block begins on (`renderMarkdown`'s `lines`), and a
 * place inside a block is reckoned in proportion, between its mark and the
 * next; the source is measured by laying its text out as its box lays it
 * out, lines wrapped as they wrap there.
 */

export interface Place {
  /** The file, by its path in the vault: a place is kept for the one it was read in. */
  readonly path: string;
  readonly line: number;
}

/** What the views of one file share: where the one left off, and how to ask the one on show where it is. */
export interface Sync {
  /** Note where the view on show of the file at `path` is, as it is about to be swapped for the other. */
  readonly leave: (path: string) => void;
  /** Where the file at `path` was left, or null when it was not, or another file was. */
  readonly at: (path: string) => number | null;
  /** The view on show says how to ask it where it is; what this returns lets that go. */
  readonly show: (read: () => number | null) => () => void;
}

/** A `Sync` for a file view, the same for as long as it is shown. */
export function useSync(): Sync {
  const [sync] = useState<Sync>(() => {
    let place: Place | null = null;
    let reader: (() => number | null) | null = null;
    return {
      leave: (path) => {
        const line = reader?.() ?? null;
        place = line === null ? null : { path, line };
      },
      at: (path) => (place !== null && place.path === path ? place.line : null),
      show: (read) => {
        reader = read;
        return () => {
          if (reader === read) reader = null;
        };
      },
    };
  });
  return sync;
}

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
 * A view of the file at `path` taking part in `sync`: once it is `ready`, it
 * is put where the last one left off, by `go`; until it goes, `read` is how
 * it says where it is, asked as it is swapped for the other.
 */
export function useKeepPlace(sync: Sync | undefined, path: string, ready: boolean, view: { read: () => number | null; go: (line: number) => (() => void) | void }): void {
  const latest = useRef({ view, path });
  useLayoutEffect(() => {
    latest.current = { view, path };
  });
  useLayoutEffect(() => {
    if (!ready || sync === undefined) return;
    const line = sync.at(latest.current.path);
    if (line === null) return;
    return latest.current.view.go(line) ?? undefined;
  }, [ready, sync]);
  useEffect(() => sync?.show(() => latest.current.view.read()), [sync]);
}
