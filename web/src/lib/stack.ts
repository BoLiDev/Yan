// Where the bubbles stand beside the squares on the rail that speak them,
// and where each one's tail meets it. A bubble is taller than the room
// between two squares, so the rail opens room between the squares that
// speak at once, and each bubble stands level with its own.

/** A bubble up: its square's middle, on screen, and its height. */
export interface Speaker {
  readonly key: string;
  readonly y: number;
  readonly h: number;
}

/**
 * The room each square needs above it, in all, for every bubble to stand
 * level with its square, `gap` under the one above: the room it has,
 * `room`, and what it lacks, for each square whose bubble would cover the
 * one above it; squares with room enough are left out.
 */
export function roomFor(speakers: readonly Speaker[], gap: number, room: Readonly<Record<string, number>>): Record<string, number> {
  const need: Record<string, number> = {};
  const down = [...speakers].sort((a, b) => a.y - b.y);
  for (let i = 1; i < down.length; i++) {
    const [above, below] = [down[i - 1]!, down[i]!];
    const lacks = Math.ceil(above.h / 2 + gap + below.h / 2 - (below.y - above.y));
    if (lacks > 0) need[below.key] = (room[below.key] ?? 0) + lacks;
  }
  return need;
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
