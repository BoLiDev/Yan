import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon';
import { cn } from '../lib/utils';
import { dropBubble, stopWaiting, useBubbles, type Bubble } from '../state/bubbles';

/** How long the words stay once they are in and the page is in sight, the pointer over them holding them there. */
const SHOWN_MS = 12_000;
/** How long it takes to go. */
const LEAVING_MS = 200;

/** Room kept between bubbles stacked one under another, and from the window's top. */
const GAP = 6;

interface Place {
  readonly left: number;
  readonly top: number;
  /** How far down the bubble its tail is, at the square's middle. */
  readonly tail: number;
  /** The square's middle, on screen, by which the bubbles stack. */
  readonly y: number;
  /** Placed for the first time: it pops there, rather than sliding there. */
  readonly first: boolean;
}

/**
 * Where the bubble goes: at the right of its square, its middle level with
 * the square's, followed frame by frame while it is up, since the rail
 * scrolls and its squares move as their tasks are worked on, neither of
 * which a resize says. A bubble keeps below those of the squares above its
 * own, so two that speak at once are both read, its tail still pointing
 * at its own square.
 */
function usePlace(anchor: RefObject<HTMLElement | null>, box: RefObject<HTMLElement | null>, n: number): Place | null {
  const [place, setPlace] = useState<Place | null>(null);
  useEffect(() => {
    let frame = 0;
    const follow = (): void => {
      const a = anchor.current?.getBoundingClientRect();
      const height = box.current?.offsetHeight ?? 0;
      if (a !== undefined && height > 0) {
        const y = Math.round(a.top + a.height / 2);
        let top = y - height / 2;
        // Only the bubbles already placed count: one not yet placed has nowhere to be kept clear of.
        for (const other of document.querySelectorAll<HTMLElement>('[data-bubble]:not([data-y=""])')) {
          const [oy, on] = [Number(other.dataset.y), Number(other.dataset.bubble)];
          if (other !== box.current && (oy < y || (oy === y && on < n))) top = Math.max(top, other.getBoundingClientRect().bottom + GAP);
        }
        top = Math.round(Math.max(GAP, top));
        const tail = Math.round(Math.min(Math.max(y - top, 14), height - 14));
        const left = Math.round(a.right + 11);
        setPlace((was) => (was !== null && was.left === left && was.top === top && was.tail === tail && was.y === y ? was : { left, top, tail, y, first: was === null }));
      }
      frame = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(frame);
  }, [anchor, box, n]);
  return place;
}

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

/** Three dots rising in turn: the agent's words are on their way. */
function Typing() {
  return (
    <span className="flex h-[19px] items-center gap-1" aria-label="typing">
      {[0, 160, 320].map((delay) => <span key={delay} className="size-1.5 rounded-full bg-current opacity-40 animate-typing" style={{ animationDelay: `${delay}ms` }} />)}
    </span>
  );
}

/** One saying: popped, typing until its words are in, held while pointed at, and gone a while after. */
function Said({ task, b, anchor }: { task: string; b: Bubble; anchor: RefObject<HTMLElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const place = usePlace(anchor, box, b.n);
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);
  const away = useAway();
  const waiting = b.text === null;

  useEffect(() => {
    if (!waiting) return;
    const id = setTimeout(() => stopWaiting(task, b.n), Math.max(0, b.until - Date.now()));
    return () => clearTimeout(id);
  }, [waiting, task, b.n, b.until]);
  useEffect(() => {
    if (waiting || held || away || leaving) return;
    const id = setTimeout(() => setLeaving(true), SHOWN_MS);
    return () => clearTimeout(id);
  }, [waiting, held, away, leaving]);
  useEffect(() => {
    if (!leaving) return;
    const id = setTimeout(() => dropBubble(task, b.n), LEAVING_MS);
    return () => clearTimeout(id);
  }, [leaving, task, b.n]);

  const open = (): void => {
    location.hash = b.to;
    dropBubble(task, b.n);
  };
  // Drawn unseen until it is placed, so its height is known to place it by.
  return createPortal(
    <div ref={box} data-bubble={b.n} data-y={place?.y ?? ''} style={{ left: place?.left ?? 0, top: place?.top ?? 0 }}
      className={cn('pointer-events-none fixed z-40', place === null && 'invisible', place !== null && !place.first && 'transition-[top] duration-200 ease-out')}>
      <div role="status" aria-label={b.title} onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)} style={{ transformOrigin: `0 ${place?.tail ?? 0}px` }}
        className={cn('group pointer-events-auto relative w-max max-w-[280px] min-w-[120px] rounded-2xl border border-(--toast-line) bg-(--toast-bg) text-(--toast-ink) shadow-[0_6px_24px_rgba(0,0,0,.16)]',
          leaving ? 'animate-bubble-out' : 'animate-bubble-pop')}>
        {/* The tail, pointing back at the square that speaks. */}
        <span style={{ top: place?.tail ?? 0 }} className="absolute -left-[6px] size-[11px] -translate-y-1/2 rotate-45 rounded-bl-[3px] border-b border-l border-(--toast-line) bg-(--toast-bg)" />
        <button type="button" onClick={open} className="relative block w-full cursor-pointer py-2 pr-6 pl-3 text-left">
          <span className="block truncate text-[11.5px] leading-4 font-semibold opacity-55">{b.title}</span>
          {waiting ? <Typing /> : <span className="block text-[13px] leading-[19px] [overflow-wrap:anywhere] line-clamp-5 animate-in fade-in slide-in-from-bottom-1 duration-300">{b.text}</span>}
        </button>
        <button type="button" aria-label="Close" onClick={() => setLeaving(true)}
          className="absolute top-1.5 right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full opacity-0 transition-opacity group-hover:opacity-60 hover:bg-black/5 hover:opacity-100 focus-visible:opacity-100">
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

/**
 * What `task`'s square on the rail says, when its agent has something to
 * tell `user`: a bubble at its right, its tail pointing back at it, popping
 * out with a bounce as the square hops. It is light whatever the theme, as
 * a toast is, so it stands off a dark page; a click on it goes where the
 * toast's button would, and it goes by itself a while after its words are
 * in, or by its ×.
 */
export function RailBubble({ task, anchor }: { task: string; anchor: RefObject<HTMLElement | null> }) {
  const b = useBubbles((s) => s.bubbles[task]);
  return b === undefined ? null : <Said key={b.n} task={task} b={b} anchor={anchor} />;
}
