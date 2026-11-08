/**
 * Names yan turns into a directory or file name: a task id, a vault name. One rule for all of them,
 * letters, digits, dot, dash and underscore, so none can carry a separator —
 * and not dots alone, which would name the directory itself or its parent.
 */
export function isRecordId(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name);
}

/**
 * Order by code point, the same on every machine and locale: task ids and file
 * names sort the way `ls` under `LC_ALL=C` shows them.
 */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Order ids of one `<prefix><n>` series by their number, the rest by code
 * point after them: `t999` before `t1000`, which code point alone puts first.
 */
export function bySeries(prefix: string): (a: string, b: string) => number {
  const n = (id: string): number | undefined => {
    const digits = id.slice(prefix.length);
    return id.startsWith(prefix) && /^\d+$/.test(digits) ? Number.parseInt(digits, 10) : undefined;
  };
  return (a, b) => {
    const [x, y] = [n(a), n(b)];
    if (x !== undefined && y !== undefined && x !== y) return x - y;
    if (x !== undefined && y === undefined) return -1;
    if (x === undefined && y !== undefined) return 1;
    return byCodePoint(a, b);
  };
}

/**
 * The next id in a `<prefix><n>` series: one past the highest `n` among `ids`,
 * zero-padded to `pad` digits. Ids that are not in the series are ignored, and
 * `n` is read in base 10, so `t008` is eight rather than an invalid octal.
 */
export function nextNumbered(ids: readonly string[], prefix: string, pad = 1): string {
  let max = 0;
  for (const id of ids) {
    const n = id.slice(prefix.length);
    if (id.startsWith(prefix) && /^\d+$/.test(n)) max = Math.max(max, Number.parseInt(n, 10));
  }
  return `${prefix}${String(max + 1).padStart(pad, '0')}`;
}
