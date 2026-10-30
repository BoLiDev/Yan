import { describe, expect, it } from 'vitest';
import { dropped, gapAt, moves } from './drag';

describe('dragging a row', () => {
  it('drops above a row from its upper half and below it from its lower', () => {
    expect(gapAt(2, true)).toBe(2);
    expect(gapAt(2, false)).toBe(3);
  });

  it('moves the row up or down into the gap, and leaves it in the gaps either side of it', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(dropped(list, 2, 0)).toEqual(['c', 'a', 'b', 'd']);
    expect(dropped(list, 0, 4)).toEqual(['b', 'c', 'd', 'a']);
    expect(dropped(list, 0, 2)).toEqual(['b', 'a', 'c', 'd']);
    expect(dropped(list, 1, 1)).toEqual(list);
    expect(dropped(list, 1, 2)).toEqual(list);
    expect(moves(1, 2)).toBe(false);
    expect(moves(1, 3)).toBe(true);
  });
});
