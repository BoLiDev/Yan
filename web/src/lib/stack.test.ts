import { describe, expect, it } from 'vitest';
import { stackBubbles, tailOf, type Speaker } from './stack';

const at = (key: string, y: number, h = 70, order = 0): Speaker => ({ key, y, h, order });

describe('the bubbles beside the rail', () => {
  it('centres one on its square, and leaves ones far apart where they are', () => {
    expect(Object.fromEntries(stackBubbles([at('a', 200), at('b', 400)], 6, 6, 800))).toEqual({ a: 165, b: 365 });
  });

  it('stands ones that would cover each other one under another, shared out above and below their squares', () => {
    const tops = stackBubbles([at('p', 280), at('s', 240), at('x', 200)], 6, 6, 800);
    expect([tops.get('x'), tops.get('s'), tops.get('p')]).toEqual([129, 205, 281]);
    // The middle one is centred on its square, the others moved alike, one up and one down.
    expect((tops.get('s') ?? 0) + 35).toBe(240);
    expect(200 - ((tops.get('x') ?? 0) + 35)).toBe((tops.get('p') ?? 0) + 35 - 280);
  });

  it('joins a group to the one above it when they would meet, and keeps them on screen', () => {
    const tops = stackBubbles([at('a', 40), at('b', 80), at('c', 150)], 6, 6, 800);
    expect(tops.get('a')).toBe(6);
    expect(tops.get('b')).toBe(82);
    expect(tops.get('c')).toBe(158);
  });

  it('points each tail into its own square, meeting the bubble on the straight of its edge, as level as it can', () => {
    expect(tailOf(240, 205, 70, 22, 12)).toEqual({ meet: 35, tip: 35 });
    expect(tailOf(280, 281, 70, 22, 12), 'square above the bubble').toEqual({ meet: 22, tip: 11 });
    expect(tailOf(200, 129, 70, 22, 12), 'square below the bubble').toEqual({ meet: 48, tip: 59 });
    expect(tailOf(250, 230, 70, 22, 12), 'within reach of level').toEqual({ meet: 22, tip: 22 });
  });
});
