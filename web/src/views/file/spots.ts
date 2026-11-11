import { useLayoutEffect, useState, type RefObject } from 'react';
import { usePageKeys } from '../../lib/modal';

/**
 * The places a change touched a document, walked one at a time: a long
 * file changed in three places is mostly what did not change, and reading
 * down it for the tints is slow. Each block the change added, took out or
 * reworded is a place (`selector`), those that follow one another one
 * place together; the one being looked at is brought to
 * the middle of the view, the first to start with, and nothing is drawn
 * round it, its own tint being mark enough (`data-current` says which it
 * is to whoever asks), and the next and the one before are a key away, J and K, round from
 * the last to the first. Counted afresh whenever what is drawn (`drawn`)
 * changes.
 */
export function useSpots(box: RefObject<HTMLElement | null>, selector: string, drawn: unknown): { at: number; total: number; step: (by: number) => void } {
  const [at, setAt] = useState(0);
  const [total, setTotal] = useState(0);
  const show = (n: number, smooth: boolean): void => {
    // Blocks changed one after another are one place: a part added is its heading and its paragraphs.
    const all: HTMLElement[][] = [];
    for (const el of box.current?.querySelectorAll<HTMLElement>(selector) ?? []) {
      if (el.previousElementSibling !== null && el.previousElementSibling === all.at(-1)?.at(-1)) all.at(-1)?.push(el);
      else all.push([el]);
    }
    setTotal(all.length);
    if (all.length === 0) return;
    const to = ((n % all.length) + all.length) % all.length;
    all.forEach((run, i) => run.forEach((el) => el.toggleAttribute('data-current', i === to)));
    all[to]?.[0]?.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
    setAt(to);
  };
  // Shown at the first, at once, as the change is drawn.
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- `show` reads the box as it is when it runs; what is drawn in it is what it runs for.
  useLayoutEffect(() => show(0, false), [drawn, selector]);
  const step = (by: number): void => show(at + by, true);
  usePageKeys((e) => {
    if (total === 0 || e.shiftKey) return false;
    if (e.key === 'j') step(1);
    else if (e.key === 'k') step(-1);
    else return false;
    return true;
  });
  return { at, total, step };
}
