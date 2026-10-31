// How a task's column draws its rows, beside the page's own parts.

import { row } from '../../components/page';
import { cn } from '../../lib/utils';

/** A task's nav: its rows one under another. */
export const NAV = 'flex flex-col gap-px';

/** A row of a task's nav, its corners a little tighter than a row of the task list's. */
export const navRow = (on = false): string => row({ on, at: 'nav' });

/**
 * A row under one that folds: a branch, a resource, an agent. The one being
 * shown is only bold, not a card; `deep` is a step further in, under a
 * repository or a kind.
 */
export const underRow = (on: boolean, deep: boolean): string =>
  cn(navRow(), 'py-1 pr-2.5 pl-9 text-ink-2 hover:text-ink-2', deep && 'pl-13', on && 'font-bold text-foreground hover:text-foreground');

/** Under MR, a repository, and under Resources a kind, each folding the rows under it a step further in. */
export const STEP_ROW = cn(navRow(), 'py-[5px] pr-2.5 pl-9 text-[13.5px] text-ink-2 hover:text-ink-2');

/** The word beside a row's icon: it stays whole, and only a name gives way. */
export const WORD = 'flex-none whitespace-nowrap';
/** A fold's chevron, at the very end, where the row's other figures end. */
export const FOLD = 'flex flex-none -mr-0.5 text-ink-3';
/** The arrow of a link that leaves the page. */
export const GO = 'flex flex-none text-ink-3';

/** A heading over a part of the column, with what it says and the tools for it beside it. */
export const SECTION = 'flex min-h-7 items-center gap-2 px-2.5';
export const SECTION_TITLE = 'text-[12.5px] text-ink-3';
