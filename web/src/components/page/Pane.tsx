import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils';

/** Where each scrolling list was left, by what it lists, for when the page comes back to it. */
const scrolls = new Map<string, number>();

/**
 * A pane: what stays at its top, what scrolls below that, and what stays at
 * its foot. The top gets a line under it once anything has scrolled under.
 * With `remember`, the list goes back to where it was left the last time it
 * listed the same thing. `tight` is the task list's: closer to its edges, and
 * its foot a card of its own with no line over it.
 */
export function Pane({ top, body, foot, remember, tight }: { top: ReactNode; body: ReactNode; foot?: ReactNode; remember?: string; tight?: boolean }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState(false);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || remember === undefined) return;
    el.scrollTop = scrolls.get(remember) ?? 0;
    setEdge(el.scrollTop > 0);
  }, [remember]);
  return (
    <>
      <div className={cn('relative z-[1] flex flex-none flex-col transition-shadow duration-150', tight ? 'gap-3 px-2.5 pt-3.5 pb-2.5' : 'gap-4 px-3 pt-[18px] pb-3',
        edge && 'shadow-[0_1px_0_var(--line),0_6px_12px_-10px_var(--shadow-strong)]')}>{top}</div>
      <div ref={scroller} data-scroll="" className={cn('flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto pt-0.5', tight ? 'px-2.5 pb-5' : 'px-3 pb-7')} onScroll={(e) => {
        const at = e.currentTarget.scrollTop;
        setEdge(at > 0);
        if (remember !== undefined) scrolls.set(remember, at);
      }}>{body}</div>
      {foot ? <div className={cn('flex-none px-3 pt-2 pb-3', !tight && 'border-t')}>{foot}</div> : null}
    </>
  );
}
