import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon';
import { roomFor, tailOf, type Speaker } from '../lib/stack';
import { cn } from '../lib/utils';
import { dropBubble, makeRoom, useBubbles, type Bubble } from '../state/bubbles';

/** How long the words stay once they are in and the page is in sight, the pointer over them holding them there. */
const SHOWN_MS = 12_000;
/** How long it takes to go. */
const LEAVING_MS = 200;
/** Room kept between bubbles one over another, and from the window's edges. */
const GAP = 6;
/** How far right of its square a bubble stands, the tail reaching back across it. */
const OFF = 11;
/** How far the tail reaches out of the bubble, and half its width where it meets it. */
const REACH = 9;
const HALF = 6;
/** How far from the bubble's top and bottom the tail keeps, on the straight of the edge, off its rounded corners. */
const KEEP = 16 + HALF;
/** How far off its square's middle the tail's tip may point, still into the square, to keep it as level as it can. */
const SPAN = 12;

/** Where a bubble is drawn, and its tail: where it meets the bubble and where its tip points, from the bubble's top. */
interface Place {
  readonly left: number;
  readonly top: number;
  readonly meet: number;
  readonly tip: number;
  /** Placed for the first time: it pops there, rather than sliding there. */
  readonly first: boolean;
}

const samePlace = (a: Place | undefined, b: Place): boolean =>
  a !== undefined && a.left === b.left && a.top === b.top && a.meet === b.meet && a.tip === b.tip;

/** Whether the page is out of sight: what a bubble says waits there for `user` to come back to it, as a toast does. */
function useAway(): boolean {
  const [away, setAway] = useState(() => document.visibilityState !== 'visible');
  useEffect(() => {
    const look = (): void => setAway(document.visibilityState !== 'visible');
    document.addEventListener('visibilitychange', look);
    return () => document.removeEventListener('visibilitychange', look);
  }, []);
  return away;
}

/**
 * The bubble easing to the width of what it says now rather than jumping
 * there, when a saying is wider or narrower than the one before. The words
 * are laid out at their own width, not the bubble's, so they keep their
 * lines while it eases and it shows them as it widens. Asked for less
 * motion, it goes there at once.
 */
function useEasedWidth(bubble: RefObject<HTMLElement | null>, v: number): void {
  const last = useRef<number | null>(null);
  const easing = useRef<Animation | null>(null);
  // Once the new words are laid out and before they are drawn, from the width on screen to theirs.
  useLayoutEffect(() => {
    const el = bubble.current;
    if (el === null) return;
    const from = easing.current === null ? last.current : el.getBoundingClientRect().width;
    easing.current?.cancel();
    easing.current = null;
    const to = el.getBoundingClientRect().width;
    last.current = to;
    if (from === null || Math.abs(to - from) < 1 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const eased = el.animate([{ width: `${from}px` }, { width: `${to}px` }], { duration: 340, easing: 'cubic-bezier(.3, .7, .2, 1)' });
    eased.onfinish = () => {
      if (easing.current === eased) easing.current = null;
    };
    easing.current = eased;
  }, [bubble, v]);
}

/**
 * What the bubble says, saying by saying: a new one rolls in from below as
 * it pushes the one before out at the top, and the bubble's height follows
 * it there rather than jumping.
 */
function Words({ v, children }: { v: number; children: ReactNode }) {
  const [shown, setShown] = useState<{ v: number; node: ReactNode }>({ v, node: children });
  const [leaving, setLeaving] = useState<{ v: number; node: ReactNode } | null>(null);
  if (shown.v !== v) {
    setLeaving(shown);
    setShown({ v, node: children });
  }
  const now = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = now.current;
    if (el === null) return;
    const watch = new ResizeObserver(() => setHeight(el.offsetHeight));
    watch.observe(el);
    return () => watch.disconnect();
  }, [v]);
  return (
    <div className="relative overflow-hidden transition-[height] duration-300 ease-out" style={{ height: height ?? undefined }}>
      {leaving === null ? null : (
        <div key={leaving.v} className="absolute inset-x-0 top-0 animate-words-out" onAnimationEnd={(e) => e.target === e.currentTarget && setLeaving(null)}>{leaving.node}</div>
      )}
      <div key={v} ref={now} className={cn(leaving !== null && 'animate-words-in')}>{children}</div>
    </div>
  );
}

/** The tail, from where it meets the bubble's edge to its tip at the square's middle, drawn over the edge's border so the two are one line. */
function Tail({ meet, tip }: { meet: number; tip: number }) {
  const top = Math.min(meet - HALF, tip) - 1;
  const height = Math.max(meet + HALF, tip) + 1 - top;
  const [a, b, t] = [meet - HALF - top, meet + HALF - top, tip - top];
  return (
    <svg aria-hidden className="pointer-events-none absolute overflow-visible" style={{ left: -REACH - 1, top, width: REACH + 2, height }}>
      <polygon points={`${REACH + 1.5},${a} 1,${t} ${REACH + 1.5},${b}`} fill="var(--toast-bg)" />
      <polyline points={`${REACH + 0.5},${a} 1,${t} ${REACH + 0.5},${b}`} fill="none" stroke="var(--toast-line)" strokeLinejoin="round" />
    </svg>
  );
}

/** One bubble: popped with its words, held while pointed at or while the page is out of sight, and gone a while after. */
function Said({ task, b, place, boxes }: { task: string; b: Bubble; place: Place | undefined; boxes: RefObject<Map<string, HTMLElement>> }) {
  // Which saying it was asked to go at: one said after that keeps it.
  const [goneAt, setGoneAt] = useState<number | null>(null);
  const leaving = goneAt === b.v;
  const [held, setHeld] = useState(false);
  const away = useAway();
  const bubble = useRef<HTMLDivElement>(null);
  useEasedWidth(bubble, b.v);

  useEffect(() => {
    if (held || away || leaving) return;
    const id = setTimeout(() => setGoneAt(b.v), SHOWN_MS);
    return () => clearTimeout(id);
  }, [held, away, leaving, b.v]);
  useEffect(() => {
    if (!leaving) return;
    const id = setTimeout(() => dropBubble(task, b.n, b.v), LEAVING_MS);
    return () => clearTimeout(id);
  }, [leaving, task, b.n, b.v]);

  const open = (): void => {
    location.hash = b.to;
    dropBubble(task, b.n);
  };
  // Drawn unseen until it is placed, so its height is known to place it by.
  return (
    <div ref={(el) => { if (el === null) boxes.current.delete(task); else boxes.current.set(task, el); }}
      style={{ left: place?.left ?? 0, top: place?.top ?? 0 }}
      className={cn('pointer-events-none fixed z-40', place === undefined && 'invisible', place !== undefined && !place.first && 'transition-[top] duration-200 ease-out')}>
      <div ref={bubble} role="status" aria-label={b.title} onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
        style={{ transformOrigin: `${-REACH}px ${place?.tip ?? 0}px` }}
        className={cn('group pointer-events-auto relative w-max max-w-[280px] min-w-[120px] rounded-2xl border border-(--toast-line) bg-(--toast-bg) text-(--toast-ink)',
          '[filter:drop-shadow(0_6px_12px_rgba(0,0,0,.12))_drop-shadow(0_1px_2px_rgba(0,0,0,.06))]', leaving ? 'animate-bubble-out' : 'animate-bubble-pop')}>
        {place === undefined ? null : <Tail meet={place.meet} tip={place.tip} />}
        {/* Each line at its own width, up to the bubble's widest, so the words keep their lines while the bubble eases to them. */}
        <button type="button" onClick={open} className="relative block w-full cursor-pointer overflow-hidden rounded-2xl py-2 pr-6 pl-3 text-left">
          <span className="block w-max max-w-[244px] truncate text-[11.5px] leading-4 font-semibold opacity-55">{b.title}</span>
          <Words v={b.v}><span className="block w-max max-w-[244px] text-[13px] leading-[19px] [overflow-wrap:anywhere] line-clamp-5">{b.text}</span></Words>
        </button>
        <button type="button" aria-label="Close" onClick={() => setGoneAt(b.v)}
          className="absolute top-1.5 right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-60 hover:bg-black/5 hover:opacity-100 focus-visible:opacity-100">
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  );
}

/**
 * What the squares on the rail say, when their agents have something to
 * tell `user`: a bubble at a square's right, level with it, its tail
 * pointing back at it, popping out with a bounce as the square hops. They
 * follow their squares frame by frame while any is up, since the rail
 * scrolls; the squares that speak stand first on the rail, and room opens
 * between them where one bubble would cover the next, so each stays level
 * with its own. They are light whatever the theme, as a
 * toast is, so they stand off a dark page; a click on one goes where the
 * toast's button would, and one goes by itself a while after its words
 * are in, or by its ×.
 */
export function RailBubbles({ squares }: { squares: RefObject<Map<string, HTMLElement>> }) {
  const bubbles = useBubbles((s) => s.bubbles);
  const boxes = useRef(new Map<string, HTMLElement>());
  const [places, setPlaces] = useState<ReadonlyMap<string, Place>>(new Map());
  const up = Object.keys(bubbles).length > 0;

  useEffect(() => {
    if (!up) return;
    let frame = 0;
    const follow = (): void => {
      const speakers: (Speaker & { readonly right: number })[] = [];
      for (const [key, box] of boxes.current) {
        const r = squares.current.get(key)?.getBoundingClientRect();
        if (r !== undefined && box.offsetHeight > 0) speakers.push({ key, y: r.top + r.height / 2, h: box.offsetHeight, right: r.right });
      }
      // The squares make room first, and the bubbles are placed once they have moved: none is placed where it would cover another.
      if (makeRoom(roomFor(speakers, GAP, useBubbles.getState().room))) {
        frame = requestAnimationFrame(follow);
        return;
      }
      setPlaces((was) => {
        const next = new Map<string, Place>();
        let changed = was.size !== speakers.length;
        for (const s of speakers) {
          const top = Math.round(Math.min(Math.max(s.y - s.h / 2, GAP), window.innerHeight - GAP - s.h));
          const { meet, tip } = tailOf(Math.round(s.y), top, s.h, KEEP, SPAN);
          const old = was.get(s.key);
          const place = { left: Math.round(s.right + OFF), top, meet, tip, first: old === undefined };
          next.set(s.key, old !== undefined && samePlace(old, place) ? old : place);
          changed ||= next.get(s.key) !== old;
        }
        return changed ? next : was;
      });
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [up, squares]);

  return createPortal(
    Object.entries(bubbles).map(([task, b]) => <Said key={`${task}:${b.n}`} task={task} b={b} place={places.get(task)} boxes={boxes} />),
    document.body,
  );
}
