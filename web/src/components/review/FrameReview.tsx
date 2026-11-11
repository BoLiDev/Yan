import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from 'react';
import { useHash } from '../../lib/route';
import { useComments, useReview } from '../../state/review';
import { filesOrigin } from '../../state/server';
import { copyText } from '../../state/ui';
import { ContextMenuItem } from '../ui/context-menu';
import { PickMenu, type PickMenuApi } from './PickMenu';

/** What a right click in the page picked, as its script says it: the words selected, or the element under the pointer. */
interface Picked {
  readonly quote: string;
  readonly exact: string;
  readonly selector: string;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 20_000) : '');

/**
 * A page an agent wrote, in its frame (`children`), commented on as any
 * other file is. The frame is on another origin, so the page here sees
 * nothing in it: the script serve adds to it (`?review`,
 * src/cli/serve/review-frame.ts) says what a right click picked and where,
 * and the menu opens here, over the frame at that point, to comment on it
 * or copy it; a press in the frame closes it, as one outside a menu does.
 * The script is told back what has been commented on, to mark it, and
 * passes on an Escape pressed in the frame that the page there left alone
 * (`onEscape`). What it
 * says is taken only from the frame itself, and is only ever words to put
 * in a comment `user` then writes: a page that made them up gains nothing.
 */
export function FrameReview({ task, path, onEscape, children }: { task: string; path: string; onEscape?: () => void; children: ReactNode }) {
  const escaped = useEffectEvent(() => onEscape?.());
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<PickMenuApi>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const hash = useHash();
  const all = useComments(task);
  const marks = useMemo(() => all.filter((c) => c.href === hash).map((c) => ({ exact: c.exact, selector: c.mark ?? '' })), [all, hash]);

  useEffect(() => {
    const frame = (): HTMLIFrameElement | null => box.current?.querySelector('iframe') ?? null;
    const tell = (): void => frame()?.contentWindow?.postMessage({ yanReview: 1, kind: 'marks', marks }, filesOrigin());
    const heard = (e: MessageEvent): void => {
      const f = frame();
      const d = e.data as { yanReview?: unknown; kind?: unknown; x?: unknown; y?: unknown; quote?: unknown; exact?: unknown; selector?: unknown } | null;
      if (f === null || e.source !== f.contentWindow || e.origin !== filesOrigin() || d?.yanReview !== 1) return;
      if (d.kind === 'ready') tell();
      else if (d.kind === 'down') menu.current?.close();
      else if (d.kind === 'escape') escaped();
      else if (d.kind === 'pick' && typeof d.x === 'number' && typeof d.y === 'number') {
        // Where the pointer was, in this page: the frame may be drawn smaller than it is laid out.
        const r = f.getBoundingClientRect();
        const scale = f.offsetWidth ? r.width / f.offsetWidth : 1;
        setPicked({ quote: text(d.quote), exact: text(d.exact), selector: text(d.selector) });
        menu.current?.open(r.left + d.x * scale, r.top + d.y * scale);
      }
    };
    addEventListener('message', heard);
    tell();
    return () => removeEventListener('message', heard);
  }, [marks]);

  const comment = (): void => {
    if (picked === null) return;
    const where = [path, picked.selector].filter(Boolean).join(', ');
    useReview.setState({ drafting: { task, where, quote: picked.quote, exact: picked.exact, mark: picked.selector, href: location.hash } });
  };

  return (
    <PickMenu api={menu} className="size-full" menu={
      <>
        <ContextMenuItem onClick={comment}>Comment</ContextMenuItem>
        {picked?.quote ? <ContextMenuItem onClick={() => copyText(picked.quote, 'Copied', 'Copy what was picked')}>Copy</ContextMenuItem> : null}
      </>
    }>
      <div ref={box} className="size-full">{children}</div>
    </PickMenu>
  );
}
