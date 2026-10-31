import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { Scroll } from '../../components/page';

/** What a branch's diffs scroll in, on the ground code is set on; its parts are drawn as they come near in it. */
export function DiffScroll({ className, ...props }: ComponentProps<'div'>) {
  return <Scroll data-diff-scroll="" className={cn('bg-[var(--code-bg)] px-5 pt-[18px] pb-12', className)} {...props} />;
}

/**
 * What is inside drawn only once it comes within a few screens of being
 * seen, holding its guessed height till then, and kept once drawn. A commit
 * can change tens of thousands of lines; drawn at once they are a hundred
 * thousand elements and the page stops for a second over them, though a
 * screenful is all that is seen.
 */
export function Later({ height, className, eager = false, children }: { height: number; className?: string; eager?: boolean; children: () => ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  // What starts on screen is drawn with the rest, not a frame after it.
  const [near, setNear] = useState(eager);
  useEffect(() => {
    const el = box.current;
    if (!el || near) return undefined;
    const watch = new IntersectionObserver((seen) => {
      if (seen.some((e) => e.isIntersecting)) setNear(true);
    }, { root: el.closest('[data-diff-scroll]'), rootMargin: '2000px 0px' });
    watch.observe(el);
    return () => watch.disconnect();
  }, [near]);
  return <div ref={box} className={className} style={near ? undefined : { height: `${height}px` }}>{near ? children() : null}</div>;
}
