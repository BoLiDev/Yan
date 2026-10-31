import type { Layout } from './api';

/** A pane's place in its tab, as fractions of the tab's room; `left` and `top` say a pane lies beyond it that way, for the line between. */
export interface Tile {
  readonly pane: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly left: boolean;
  readonly top: boolean;
}

/**
 * Each pane of a tab where herdr's split puts it: a split's first part takes
 * its ratio of the room, beside (`right`) or above (`down`) the second.
 * Flat, so a pane keeps its place on the page, and its terminal, as the tab
 * around it is split and closed.
 */
export function tilesOf(layout: Layout, x = 0, y = 0, w = 1, h = 1): Tile[] {
  if ('pane' in layout) return [{ pane: layout.pane, x, y, w, h, left: x > 1e-6, top: y > 1e-6 }];
  if (layout.split === 'right') {
    const first = w * layout.ratio;
    return [...tilesOf(layout.first, x, y, first, h), ...tilesOf(layout.second, x + first, y, w - first, h)];
  }
  const first = h * layout.ratio;
  return [...tilesOf(layout.first, x, y, w, first), ...tilesOf(layout.second, x, y + first, w, h - first)];
}
