import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { usePageKeys } from '../lib/modal';
import { useUI } from '../state/ui';

/** Where ← and → go from the view on the right, for as long as it is shown. */
export function useKeyNav(prev: string | null, next: string | null): void {
  useEffect(() => {
    useUI.setState({ keyNav: { prev, next } });
    return () => useUI.setState({ keyNav: { prev: null, next: null } });
  }, [prev, next]);
}

/**
 * One of a page's cards picked, the first to start: ↑ and ↓ pick another
 * and Enter opens it, unless the keyboard is in a field, the ⌘K box is open
 * or a modifier is held. The list holding the cards keeps the picked one in
 * view; each card says it is picked with aria-selected.
 */
export function usePick(count: number, open: (at: number) => void): { at: number; pick: (at: number) => void; list: RefObject<HTMLDivElement | null> } {
  const [at, pick] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // In a block: scrollIntoView returns a promise in newer browsers, which React would take for a cleanup.
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  usePageKeys((e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      pick((a) => Math.max(0, Math.min(count - 1, a + (e.key === 'ArrowDown' ? 1 : -1))));
      return true;
    }
    // Enter with nothing else having the keyboard opens the card picked.
    const active = document.activeElement;
    if (e.key === 'Enter' && (!active || active === document.body) && at < count) {
      open(at);
      return true;
    }
    return false;
  });
  return { at, pick, list };
}
