import { describe, expect, it } from 'vitest';
import { tilesOf } from './tiles';

describe('a tab\'s panes laid out as herdr splits them', () => {
  it('is the pane alone, filling the room', () => {
    expect(tilesOf({ pane: 'w1:p2' })).toEqual([{ pane: 'w1:p2', x: 0, y: 0, w: 1, h: 1, left: false, top: false }]);
  });

  it('gives a split\'s first part its ratio, beside or above the second, with a line where one meets another', () => {
    const tiles = tilesOf({ split: 'right', ratio: 0.6, first: { pane: 'agent' }, second: { split: 'down', ratio: 0.25, first: { pane: 'a' }, second: { pane: 'b' } } });
    expect(tiles.map((t) => [t.pane, +t.x.toFixed(3), +t.y.toFixed(3), +t.w.toFixed(3), +t.h.toFixed(3), t.left, t.top])).toEqual([
      ['agent', 0, 0, 0.6, 1, false, false],
      ['a', 0.6, 0, 0.4, 0.25, true, false],
      ['b', 0.6, 0.25, 0.4, 0.75, true, true],
    ]);
  });
});
