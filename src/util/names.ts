/**
 * Names yan turns into a directory or file name: a task or shift id, a
 * repository or vault name, a harness session id. One rule for all of them,
 * letters, digits, dot, dash and underscore, so none can carry a separator —
 * and not dots alone, which would name the directory itself or its parent.
 */
export function isRecordId(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name) && !/^\.+$/.test(name);
}

/**
 * Order by code point, the same on every machine and locale: task ids, shift
 * ids and file names sort the way `ls` under `LC_ALL=C` shows them.
 */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
