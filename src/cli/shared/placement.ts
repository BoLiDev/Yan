import type { PaneRect, SplitAt, TabLayout } from '../../externals/herdr/index.js';
import { Shift } from '../../records/shift/index.js';
import { paneOfEnterLock } from './enter-lock.js';

/**
 * Where a new shift's pane goes: a split in the main agent's tab. The main
 * pane is the one `user` talks in, so it is never made smaller while the tab
 * holds anything else to split.
 *
 * - A live shift pane in the tab: the largest shift pane is halved, as below.
 * - No shift pane, but panes of `user`'s own (neither main nor a shift's):
 *   the largest of those is halved `down`, same tie-break, so the first shift
 *   lands under `user`'s pane. From then on the first rule takes over, and
 *   `user`'s pane is not split again while shift panes are there to halve.
 * - The main pane alone: it is halved to the right, and the shifts share the
 *   right half while the main agent keeps the left.
 *
 * Among shift panes the largest is halved — ties to the topmost, then the
 * leftmost, so the top row fills first — and the direction alternates with
 * how many halvings that pane is from the main pane's size: `down` at an
 * even count, `right` at an odd one. That gives `user`'s own sequence (s2
 * under s1, s3 beside s1, s4 beside s2) and keeps working after panes close
 * in any order, because it reads the tab as it is rather than counting
 * shifts. Beside a pane of `user`'s the main pane is half the tab, so the
 * first shift is already one halving from it and the same sequence carries
 * on from its second step (s2 beside s1, then down).
 */

/** A live shift's recorded pane. */
export interface ShiftPane {
  readonly sid: string;
  readonly pane: string;
}

function area(rect: PaneRect): number {
  return rect.width * rect.height;
}

/** Whether `a` comes first reading the tab: higher up, then further left. */
function readsBefore(a: PaneRect, b: PaneRect): boolean {
  return a.y !== b.y ? a.y < b.y : a.x < b.x;
}

/**
 * The largest of `panes` that is in the tab, ties to the topmost, then the
 * leftmost; `undefined` when none is.
 */
function largest(
  panes: readonly string[],
  rects: ReadonlyMap<string, PaneRect>,
): { pane: string; area: number; rect: PaneRect } | undefined {
  let best: { pane: string; area: number; rect: PaneRect } | undefined;
  for (const pane of panes) {
    const rect = rects.get(pane);
    if (rect === undefined) continue;
    const candidate = { pane, area: area(rect), rect };
    if (best === undefined || candidate.area > best.area ||
        (candidate.area === best.area && readsBefore(rect, best.rect))) {
      best = candidate;
    }
  }
  return best;
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

  const shiftPanes = new Set(shifts.map((s) => s.pane));
  const target = largest(shifts.map((s) => s.pane).filter((pane) => pane !== mainPane), rects);
  if (target === undefined) {
    const users = layout.panes.map((p) => p.pane).filter((pane) => pane !== mainPane && !shiftPanes.has(pane));
    const own = largest(users, rects);
    return own === undefined ? { pane: mainPane, direction: 'right' } : { pane: own.pane, direction: 'down' };
  }

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
