import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/utils';

/**
 * The page's rows, in the task list, a task's nav and its trees: an icon,
 * what it is, and figures at its end. The one being shown is a card.
 */
const rows = cva(
  'flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-[7px] text-left text-foreground no-underline hover:bg-hover hover:text-foreground [&_svg]:shrink-0',
  {
    variants: {
      on: { true: 'bg-card font-bold ring-1 ring-border hover:bg-card', false: '' },
      /** In a task's nav and its trees the rows are a little less round than the task list's; in a tree, closer together too. */
      at: { list: '', nav: 'rounded-[8px]', tree: 'gap-2 rounded-[8px] py-1 text-[13.5px]' },
    },
    defaultVariants: { on: false, at: 'list' },
  },
);

/** A row's classes, a variant's taking the place of the base's it overrides (cva alone would keep both, and CSS order would pick). */
export const row = (v?: VariantProps<typeof rows>): string => cn(rows(v));

/** What a row says at its end: a count, a state, a name given way. */
export const ASIDE = 'flex-none text-[12px] font-normal text-ink-3 tabular-nums';
/** What a row is, taking the room left and giving way first. */
export const GROW = 'min-w-0 flex-1 truncate';
/** A heading over a group of rows. */
export const LABEL = 'px-2.5 pt-1 pb-1.5 text-[12.5px] font-bold text-ink-3';
/** A line under a heading, said when a group has nothing or as a note. */
export const SUBLABEL = 'px-2.5 pt-2 pb-1 text-[12px] text-ink-3';
/** A file's kind as a small tile where a picture would be. */
export const KIND = 'h-[22px] w-[30px] flex-none overflow-hidden rounded bg-hover text-center font-mono text-[8.5px] leading-[22px] font-bold text-ink-2';
/** A picture shown small where a file's kind would be. */
export const THUMB = 'h-[22px] w-[30px] flex-none rounded bg-[var(--thumb-well)] object-cover';
