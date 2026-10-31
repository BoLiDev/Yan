// The page's own keys, in one place: what a key does on the page when no
// field is being typed in and no box over the page has the keys.

import { useEffect, useEffectEvent } from 'react';

/**
 * Whether a box is open over the page: while one is, the keys are its, and
 * the page's own wait. Base UI's dialogs say so as open dialogs; one drawn
 * by hand, the report's own, with aria-modal.
 */
export const boxOpen = (): boolean =>
  document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open], [aria-modal="true"]') !== null;

/** Whether the keyboard is in something typed into: a field, or text being edited where it stands. */
export function typing(): boolean {
  const active = document.activeElement as HTMLElement | null;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName ?? '') || !!active?.isContentEditable;
}

/** A key for the page: true when it took the key, which then goes nowhere else. */
export type PageKey = (e: KeyboardEvent) => boolean;

const taking = new Set<{ readonly current: PageKey }>();

function onKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || typing() || boxOpen() || e.altKey || e.ctrlKey || e.metaKey) return;
  // Asked in turn, the last to start listening first, until one takes it.
  for (const k of [...taking].reverse()) {
    if (k.current(e)) {
      e.preventDefault();
      return;
    }
  }
}

/**
 * `take` is asked for each key pressed on the page while the part using it
 * is drawn, unless a field has the keyboard, a box is open over the page or
 * a modifier is held. It reads whatever it needs as it is when the key comes.
 */
export function usePageKeys(take: PageKey): void {
  const now = useEffectEvent(take);
  useEffect(() => {
    const k = { current: (e: KeyboardEvent) => now(e) };
    if (taking.size === 0) document.addEventListener('keydown', onKey);
    taking.add(k);
    return () => {
      taking.delete(k);
      if (taking.size === 0) document.removeEventListener('keydown', onKey);
    };
  }, []);
}
