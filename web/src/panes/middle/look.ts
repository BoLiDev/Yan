// How a task's column draws its rows, beside the page's own parts.

import { row } from '../../components/page';

/** A task's nav: its rows one under another, far enough apart that a lit row and a focused one do not touch. */
export const NAV = 'flex flex-col gap-0.5';

/** A row of a task's nav, its corners a little tighter than a row of the task list's. */
export const navRow = (on = false): string => row({ on, at: 'nav' });

/** A heading over a part of the column, with what it says and the tools for it beside it. */
export const SECTION = 'flex min-h-7 items-center gap-2 px-2.5';
export const SECTION_TITLE = 'text-[12.5px] text-ink-3';
