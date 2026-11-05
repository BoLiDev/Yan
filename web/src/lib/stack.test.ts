import { describe, expect, it } from 'vitest';
import { roomFor, tailOf, type Speaker } from './stack';

const at = (key: string, y: number, h = 70): Speaker => ({ key, y, h });

describe('the bubbles beside the rail', () => {
  it('opens room above a square whose bubble would cover the one above, and none where there is room', () => {
    expect(roomFor([at('a', 200), at('b', 240)], 6, {}), 'two squares together').toEqual({ b: 36 });
    expect(roomFor([at('b', 276), at('a', 200)], 6, { b: 36 }), 'room enough once opened').toEqual({});
    expect(roomFor([at('a', 200), at('b', 400)], 6, {}), 'far apart').toEqual({});
  });

  it('opens what a square lacks on top of what it has, when the bubble above grows', () => {
    expect(roomFor([at('a', 200, 90), at('b', 276)], 6, { b: 36 })).toEqual({ b: 46 });
  });

  it('points each tail into its own square, meeting the bubble on the straight of its edge, as level as it can', () => {
    expect(tailOf(240, 205, 70, 22, 12)).toEqual({ meet: 35, tip: 35 });
    expect(tailOf(280, 281, 70, 22, 12), 'square above the bubble').toEqual({ meet: 22, tip: 11 });
    expect(tailOf(200, 129, 70, 22, 12), 'square below the bubble').toEqual({ meet: 48, tip: 59 });
    expect(tailOf(250, 230, 70, 22, 12), 'within reach of level').toEqual({ meet: 22, tip: 22 });
  });
});
