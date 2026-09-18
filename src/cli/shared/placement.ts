import type { PaneRect, SplitAt, TabLayout } from '../../externals/herdr/index.js';
import { Shift } from '../../records/shift/index.js';
import { paneOfEnterLock } from './enter-lock.js';

/**
 * Where a new shift's pane goes: a split in the main agent's tab, with the
 * shifts sharing its right half and the main agent keeping the left.
 *
 * The first shift halves the main pane to the right. After that the largest
 * shift pane in the tab is halved — ties to the lowest shift number — and the
 * direction alternates with how many halvings that pane is from the main
 * pane's size: `down` at an even count, `right` at an odd one. That gives
 * `user`'s own sequence (s2 under s1, s3 beside s1, s4 beside s2) and keeps
 * working after panes close in any order, because it reads the tab as it is
 * rather than counting shifts.
 */

/** A live shift's recorded pane. */
export interface ShiftPane {
  readonly sid: string;
  readonly pane: string;
}

function area(rect: PaneRect): number {
  return rect.width * rect.height;
}

/** `s12` → 12, for ordering ties the way a person counts. */
function shiftNumber(sid: string): number {
  const n = Number.parseInt(sid.replace(/^\D+/, ''), 10);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

/**
 * The split for the next shift, or `undefined` when the main pane is not in
 * `layout` — the caller then does what it did before splits. Shift panes not
 * in the layout (closed, or moved to another tab) are ignored.
 */
export function placeShift(
  mainPane: string,
  layout: TabLayout,
  shifts: readonly ShiftPane[],
): SplitAt | undefined {
  const rects = new Map(layout.panes.map((p) => [p.pane, p.rect]));
  const main = rects.get(mainPane);
  if (main === undefined) return undefined;

  let target: { pane: string; area: number; n: number } | undefined;
  for (const shift of shifts) {
    const rect = shift.pane === mainPane ? undefined : rects.get(shift.pane);
    if (rect === undefined) continue;
    const candidate = { pane: shift.pane, area: area(rect), n: shiftNumber(shift.sid) };
    if (target === undefined || candidate.area > target.area ||
        (candidate.area === target.area && candidate.n < target.n)) {
      target = candidate;
    }
  }
  if (target === undefined) return { pane: mainPane, direction: 'right' };

  const halvings = target.area > 0 ? Math.max(0, Math.round(Math.log2(area(main) / target.area))) : 0;
  return { pane: target.pane, direction: halvings % 2 === 0 ? 'down' : 'right' };
}

/** What placing a shift needs from the terminal; `Terminal` is the real one. */
export interface PlacingTerminal {
  tabLayout(pane: string): TabLayout | undefined;
}

/**
 * Where this task's next shift goes in `container`, or `undefined` for a tab
 * of its own: no main agent on record, a layout Herdr will not give, or a
 * main pane that is not in the container the shift is being recorded in.
 * Creates nothing.
 */
export function placementOf(task: string, container: string, terminal: PlacingTerminal): SplitAt | undefined {
  const main = paneOfEnterLock(task);
  if (main === undefined) return undefined;
  const layout = terminal.tabLayout(main);
  if (layout === undefined || layout.workspace !== container) return undefined;

  const shifts: ShiftPane[] = [];
  for (const shift of Shift.liveIn(task)) {
    const pane = shift.meta().pane;
    if (pane !== undefined && pane !== '') shifts.push({ sid: shift.sid, pane });
  }
  return placeShift(main, layout, shifts);
}
