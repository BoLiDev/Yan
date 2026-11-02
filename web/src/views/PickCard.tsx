import type { ComponentProps, HTMLAttributes, ReactNode, RefObject } from 'react';
import { Icon } from '../components/Icon';
import { SHIMMER, Scroll } from '../components/page';
import { Button } from '../components/ui/button';
import { Kbd } from '../components/ui/kbd';
import { cn } from '../lib/utils';
import { copyText } from '../state/ui';

/**
 * What a row of the task's nav holds, on its own page: its agents, its
 * merge requests and branches, or its resources, a card each in a column
 * under the bar, Enter opening the picked one.
 */
export function PickList({ list, children }: { list: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  return (
    <Scroll>
      <div className="flex max-w-[720px] flex-col gap-2.5 px-8 py-7" ref={list}>{children}</div>
    </Scroll>
  );
}

/**
 * A card's tool that copies `text`, `what` it is, without opening the card:
 * a branch's name, a merge request's link. Clicked, it gives the keys back
 * to the page, so the arrows and Enter go on picking and opening cards.
 */
export function CopyTool({ text, what }: { text: string; what: string }) {
  return (
    <Button variant="ghost" size="icon-xs" className="text-ink-3" title={`Copy ${what}`} aria-label={`Copy ${what}`}
      onClick={(e) => { e.currentTarget.blur(); copyText(text, `Copied ${what}`, what); }}>
      <Icon name="copy" size={14} />
    </Button>
  );
}

/** A heading over the cards of one kind, or one repository. */
export function PickHeading({ children }: { children: ReactNode }) {
  return <div className="mt-2 text-[12.5px] font-bold text-ink-3">{children}</div>;
}

/**
 * One card: its icon, and a link that is the whole card, its name over
 * where it points, with `hint` the key that opens it. The picked one is
 * drawn darker, whatever is under the pointer, which picks the card it
 * moves over. `tools`, on hover or focus, change what the card is of;
 * `editing` stands in for the link while where it points is edited; `drag`
 * takes a card dragged by its link, which a browser lets be dragged, and
 * `line` draws where a card dragged over it would drop.
 */
export function PickCard({ icon, name, where, picked, hint, shimmer, mono, tools, editing, onPick, drag, line, faint, ...link }: ComponentProps<'a'> & {
  icon: ReactNode;
  name: string;
  where: string;
  picked: boolean;
  hint: boolean;
  shimmer?: boolean;
  /** The name is code, as a branch's is. */
  mono?: boolean;
  tools?: ReactNode;
  editing?: ReactNode;
  onPick: () => void;
  drag?: HTMLAttributes<HTMLDivElement>;
  line?: 'above' | 'below';
  /** Being dragged. */
  faint?: boolean;
}) {
  return (
    <div className={cn('group/card relative flex items-center gap-3.5 rounded-[12px] bg-card px-4 py-3.5 text-ink', picked ? 'ring-[1.5px] ring-ink-2' : 'ring-1 ring-border hover:ring-ink-3', faint && 'opacity-45')}
      onMouseMove={onPick} {...drag}>
      {line ? <span className={cn('pointer-events-none absolute inset-x-2 h-0.5 rounded-[2px] bg-brand', line === 'above' ? '-top-[6px]' : '-bottom-[6px]')} /> : null}
      {icon}
      {/* The hint keeps its width and its line; a long name or address gives way, ending in an ellipsis. */}
      {editing ?? (
        <a className="flex min-w-0 flex-auto flex-col gap-0.5 truncate text-inherit no-underline after:absolute after:inset-0 after:rounded-[12px]"
          aria-selected={picked} title={where} {...link}>
          <b className={cn('truncate', mono && 'font-mono text-[13px]', shimmer && SHIMMER)}>{name}</b>
          <span className="truncate text-[12.5px] text-ink-3">{where}</span>
        </a>
      )}
      {/* Over the link that is the whole card, so they are clicked themselves. */}
      {tools && !editing ? <span className="relative z-10 -my-1 hidden flex-none gap-0.5 group-hover/card:flex group-focus-within/card:flex">{tools}</span> : null}
      {hint && !editing ? <span className="flex flex-none items-center gap-1.5 text-xs text-muted-foreground">Open<Kbd>↵</Kbd></span> : null}
    </div>
  );
}
