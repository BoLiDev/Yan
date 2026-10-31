import type { ComponentProps, ReactNode, RefObject } from 'react';
import { Scroll } from '../components/page';
import { Kbd } from '../components/ui/kbd';
import { cn } from '../lib/utils';

/**
 * A light passing over a name: what the agent tab is showing while this page
 * holds it. Asked for less motion, the name is the light's colour and still.
 */
export const SHIMMER = 'animate-shimmer bg-[linear-gradient(100deg,var(--brand)_0%,var(--brand)_38%,var(--brand-glint)_50%,var(--brand)_62%,var(--brand)_100%)] bg-size-[250%_100%] bg-position-[100%_0] bg-clip-text text-transparent motion-reduce:animate-none motion-reduce:bg-none motion-reduce:text-brand';

/** A task's agents or its resources, as Tab comes to them: a card each, in a column under the bar, Enter opening the picked one. */
export function PickList({ list, children }: { list: RefObject<HTMLDivElement | null>; children: ReactNode }) {
  return (
    <Scroll>
      <div className="flex max-w-[720px] flex-col gap-2.5 px-8 py-7" ref={list}>{children}</div>
    </Scroll>
  );
}

/**
 * One of them, a link: its icon, its name over where it points, and, with
 * `hint`, the key that opens it. The picked one is drawn darker, whatever is
 * under the pointer.
 */
export function PickCard({ icon, name, where, picked, hint, shimmer, ...link }: ComponentProps<'a'> & {
  icon: ReactNode;
  name: string;
  where: string;
  picked: boolean;
  hint: boolean;
  shimmer?: boolean;
}) {
  return (
    <a className={cn('flex items-center gap-3.5 rounded-[12px] bg-card px-4 py-3.5 text-ink no-underline', picked ? 'ring-[1.5px] ring-ink-2' : 'ring-1 ring-border hover:ring-ink-3')}
      aria-selected={picked} title={where} {...link}>
      {icon}
      {/* The hint keeps its width and its line; a long name or address gives way, ending in an ellipsis. */}
      <span className="flex min-w-0 flex-auto flex-col gap-0.5 truncate">
        <b className={cn('truncate', shimmer && SHIMMER)}>{name}</b>
        <span className="truncate text-[12.5px] text-ink-3">{where}</span>
      </span>
      {hint ? <span className="flex flex-none items-center gap-1.5 text-xs text-muted-foreground">Open<Kbd>↵</Kbd></span> : null}
    </a>
  );
}
