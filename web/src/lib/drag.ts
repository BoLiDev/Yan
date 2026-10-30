// Dragging a row to another place in its list.

/** The gap a row dragged over row `i` drops into: above it from its upper half, below it from its lower. */
export const gapAt = (i: number, upper: boolean): number => (upper ? i : i + 1);

/** Whether dropping the row at `from` into `gap` moves it: the gaps either side of it leave it where it is. */
export const moves = (from: number, gap: number): boolean => gap !== from && gap !== from + 1;

/** The list with the item at `from` dropped into `gap`, a gap counted before the item was lifted. */
export function dropped<T>(list: readonly T[], from: number, gap: number): T[] {
  const item = list[from];
  if (item === undefined || !moves(from, gap)) return [...list];
  const rest = list.filter((_, i) => i !== from);
  const at = gap > from ? gap - 1 : gap;
  return [...rest.slice(0, at), item, ...rest.slice(at)];
}
