import { describe, expect, it } from 'vitest';
import type { PaneRect, SplitAt, TabLayout } from '../../externals/herdr/index.js';
import { placeShift, type ShiftPane } from './placement.js';

/**
 * The placement rule walked on synthetic tabs: each step asks the rule, then
 * splits the chosen pane the way Herdr would, so the next step reads the tab
 * the last one left.
 */

const MAIN = 'w1:p1';

interface Tab {
  rects: Map<string, PaneRect>;
  shifts: ShiftPane[];
}

function freshTab(): Tab {
  return { rects: new Map([[MAIN, { x: 0, y: 0, width: 240, height: 64 }]]), shifts: [] };
}

function layoutOf(tab: Tab): TabLayout {
  return { workspace: 'w1', tab: 'w1:t1', panes: [...tab.rects].map(([pane, rect]) => ({ pane, rect })) };
}

/** Herdr's split at ratio 0.5: the target keeps the left or top half. */
function split(tab: Tab, at: SplitAt, sid: string): void {
  const r = tab.rects.get(at.pane);
  if (r === undefined) throw new Error(`no pane ${at.pane}`);
  const pane = `w1:p${sid}`;
  if (at.direction === 'right') {
    const w = Math.floor(r.width / 2);
    tab.rects.set(at.pane, { ...r, width: w });
    tab.rects.set(pane, { ...r, x: r.x + w, width: r.width - w });
  } else {
    const h = Math.floor(r.height / 2);
    tab.rects.set(at.pane, { ...r, height: h });
    tab.rects.set(pane, { ...r, y: r.y + h, height: r.height - h });
  }
  tab.shifts.push({ sid, pane });
}

/** Dispatch `sid`: ask the rule, split, and answer with what was asked. */
function dispatch(tab: Tab, sid: string): string {
  const at = placeShift(MAIN, layoutOf(tab), tab.shifts);
  if (at === undefined) throw new Error('the rule declined');
  split(tab, at, sid);
  const target = at.pane === MAIN ? 'main' : at.pane.replace('w1:p', '');
  return `${sid}: ${target} ${at.direction}`;
}

/**
 * Herdr's close: the pane's sibling in the split tree absorbs its space. The
 * tree is not modelled here, so the test names the sibling.
 */
function close(tab: Tab, sid: string, sibling: string): void {
  const pane = `w1:p${sid}`;
  const into = sibling === 'main' ? MAIN : `w1:p${sibling}`;
  const gone = tab.rects.get(pane);
  const r = tab.rects.get(into);
  if (gone === undefined || r === undefined) throw new Error(`no pane ${pane} or ${into}`);
  tab.rects.delete(pane);
  tab.shifts = tab.shifts.filter((s) => s.pane !== pane);
  const x = Math.min(r.x, gone.x);
  const y = Math.min(r.y, gone.y);
  const width = r.y === gone.y ? r.width + gone.width : r.width;
  const height = r.x === gone.x ? r.height + gone.height : r.height;
  tab.rects.set(into, { x, y, width, height });
}

describe('where a shift goes in the main agent tab', () => {
  it("walks user's sequence, and on through s8", () => {
    const tab = freshTab();
    const steps = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'].map((sid) => dispatch(tab, sid));
    expect(steps).toEqual([
      's1: main right',
      's2: s1 down',
      's3: s1 right',
      's4: s2 right',
      's5: s1 down',
      // s2, s3 and s4 are all quarters now: the tie goes to the topmost, then
      // the leftmost, so the top row fills first.
      's6: s3 down',
      's7: s2 down',
      's8: s4 down',
    ]);
    // The main agent keeps the left half however many shifts there are.
    expect(tab.rects.get(MAIN)).toEqual({ x: 0, y: 0, width: 120, height: 64 });
  });

  it('goes on to split eighths right from s9', () => {
    const tab = freshTab();
    for (let n = 1; n <= 8; n += 1) dispatch(tab, `s${n}`);
    expect(dispatch(tab, 's9')).toBe('s9: s1 right');
  });

  it('recovers when s1 closes in the four-pane layout: s3 owns the top right and is split right', () => {
    const tab = freshTab();
    for (const sid of ['s1', 's2', 's3', 's4']) dispatch(tab, sid);
    close(tab, 's1', 's3');
    expect(tab.rects.get('w1:ps3')).toEqual({ x: 120, y: 0, width: 120, height: 32 });
    expect(dispatch(tab, 's5')).toBe('s5: s3 right');
  });

  it('starts over at the main pane once every shift pane is gone', () => {
    const tab = freshTab();
    dispatch(tab, 's1');
    close(tab, 's1', 'main');
    expect(dispatch(tab, 's2')).toBe('s2: main right');
  });

  it('ignores a shift pane that is not in this tab', () => {
    const tab = freshTab();
    const at = placeShift(MAIN, layoutOf(tab), [{ sid: 's1', pane: 'w1:p9' }]);
    expect(at).toEqual({ pane: MAIN, direction: 'right' });
  });

  it('breaks a tie by position, top then left, never by shift number', () => {
    const layout: TabLayout = {
      workspace: 'w1',
      tab: 'w1:t1',
      panes: [
        { pane: MAIN, rect: { x: 0, y: 0, width: 100, height: 40 } },
        { pane: 'w1:pa', rect: { x: 100, y: 20, width: 50, height: 20 } },
        { pane: 'w1:pb', rect: { x: 150, y: 0, width: 50, height: 20 } },
        { pane: 'w1:pc', rect: { x: 100, y: 0, width: 50, height: 20 } },
      ],
    };
    const shifts = [{ sid: 's1', pane: 'w1:pa' }, { sid: 's2', pane: 'w1:pb' }, { sid: 's3', pane: 'w1:pc' }];
    expect(placeShift(MAIN, layout, shifts)?.pane).toBe('w1:pc');
  });

  it('declines when the main pane is not in the layout, so the caller makes a tab', () => {
    const tab = freshTab();
    expect(placeShift('w1:p7', layoutOf(tab), [])).toBeUndefined();
  });
});
