/**
 * Names yan turns into a directory or file name: a task or shift id, a
 * repository or vault name, a harness session id. One rule for all of them,
 * letters, digits, dot, dash and underscore, so none can carry a separator.
 */
export function isRecordId(name: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(name);
}

/**
 * Order by code point, the same on every machine and locale: task ids, shift
 * ids and file names sort the way `ls` under `LC_ALL=C` shows them.
 */
export function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
