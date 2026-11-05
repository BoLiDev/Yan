// Where the bubbles stand beside the squares on the rail that speak them,
// and where each one's tail meets it: worked out for all of them at once,
// since a bubble is taller than the room between two squares.

/** A bubble to place: its square's middle, on screen, its height, and its place among those of one square's height. */
export interface Speaker {
  readonly key: string;
  readonly y: number;
  readonly h: number;
  readonly order: number;
}

/**
 * Each bubble's top. A bubble alone is centred on its square; bubbles that
 * would cover one another stand one under another, `gap` apart, the group
 * as near as it can be to centred on its squares, so the room it needs is
 * shared out above and below them rather than all pushed down; and none
 * goes above `least` or, while it fits, below `most`.
 */
export function stackBubbles(speakers: readonly Speaker[], gap: number, least: number, most: number): Map<string, number> {
  const groups: { members: Speaker[]; top: number; height: number }[] = [];
  const centre = (g: (typeof groups)[number]): void => {
    let offset = 0;
    let sum = 0;
    for (const s of g.members) {
      sum += s.y - s.h / 2 - offset;
      offset += s.h + gap;
    }
    g.height = offset - gap;
    g.top = Math.min(Math.max(sum / g.members.length, least), Math.max(least, most - g.height));
  };
  for (const s of [...speakers].sort((a, b) => a.y - b.y || a.order - b.order)) {
    const g = { members: [s], top: 0, height: 0 };
    centre(g);
    groups.push(g);
    // A group that now reaches the one above joins it, which may then reach the one above that.
    for (let last = groups.at(-1), above = groups.at(-2); last && above && last.top < above.top + above.height + gap; last = groups.at(-1), above = groups.at(-2)) {
      groups.pop();
      above.members.push(...last.members);
      centre(above);
    }
  }
  const tops = new Map<string, number>();
  for (const g of groups) {
    let top = g.top;
    for (const s of g.members) {
      tops.set(s.key, top);
      top += s.h + gap;
    }
  }
  return tops;
}

/**
 * Where a bubble's tail meets its left edge, and where its tip points, both
 * from the bubble's top. It meets the bubble level with its square's middle,
 * `y`, as near as it can on the straight of the edge, `keep` clear of the
 * rounded corners; and its tip points into the square, as level as it can,
 * at most `span` off the square's middle. A bubble moved off its square so
 * meets its tail where it can and slants it a little to the square, rather
 * than stretching it to the square's middle.
 */
export function tailOf(y: number, top: number, h: number, keep: number, span: number): { meet: number; tip: number } {
  const middle = y - top;
  const meet = Math.min(Math.max(middle, keep), Math.max(keep, h - keep));
  return { meet, tip: Math.min(Math.max(meet, middle - span), middle + span) };
}
