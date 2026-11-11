/**
 * What changed inside a line of prose. A paragraph of Markdown is one
 * line, so a line taken out and a line put in its place say only that
 * something in the paragraph changed; compared piece by piece, they say
 * which words.
 */

/** A line as what is compared: words in Latin letters and digits whole, a run of spaces, and any other character, a Chinese one or a mark, on its own. */
export const pieces = (s: string): string[] => s.match(/[\p{Script=Latin}\p{N}_]+|\s+|[\s\S]/gu) ?? [];

/** Past this many cells, the table two lists are compared in is not built, and only what they begin and end alike is taken as kept. */
const CELLS = 4_000_000;

/** Which of `a` and which of `b` are in both, in order: the longest such run of them. */
export function kept(a: readonly string[], b: readonly string[]): [boolean[], boolean[]] {
  const [inA, inB] = [a.map(() => false), b.map(() => false)];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) inA[start] = inB[start++] = true;
  let [endA, endB] = [a.length, b.length];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) inA[--endA] = inB[--endB] = true;
  const [n, m] = [endA - start, endB - start];
  if (n === 0 || m === 0 || n * m > CELLS) return [inA, inB];
  // The length of the longest run kept from each place on, filled from the end.
  const len = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      len[i * (m + 1) + j] = a[start + i] === b[start + j] ? (len[(i + 1) * (m + 1) + j + 1] as number) + 1 : Math.max(len[(i + 1) * (m + 1) + j] as number, len[i * (m + 1) + j + 1] as number);
    }
  }
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[start + i] === b[start + j]) inA[start + i++] = inB[start + j++] = true;
    else if ((len[(i + 1) * (m + 1) + j] as number) >= (len[i * (m + 1) + j + 1] as number)) i++;
    else j++;
  }
  return [inA, inB];
}

/** How much of two texts is the same, of the longer one, by their words: 0 for nothing, 1 for all. */
export function alike(old: string, now: string): number {
  const [a, b] = [pieces(old), pieces(now)];
  const [inA] = kept(a, b);
  const words = (all: readonly string[]): number => all.filter((p) => p.trim() !== '').length;
  const most = Math.max(words(a), words(b));
  return most === 0 ? 1 : a.filter((p, i) => inA[i] && p.trim() !== '').length / most;
}

/**
 * An old line and the new one in its place as one: what both have as it
 * is, what only the old has wrapped by `gone`, what only the new has by
 * `come`, the old before the new where one took the other's place.
 */
export function mergeWords(old: string, now: string, gone: (s: string) => string, come: (s: string) => string): string {
  const [a, b] = [pieces(old), pieces(now)];
  const [inA, inB] = kept(a, b);
  let out = '';
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    let [x, y] = [i, j];
    while (x < a.length && !inA[x]) x++;
    while (y < b.length && !inB[y]) y++;
    if (x > i) out += gone(a.slice(i, x).join(''));
    if (y > j) out += come(b.slice(j, y).join(''));
    [i, j] = [x, y];
    // What both have, a piece of each at a time.
    while (i < a.length && j < b.length && inA[i] && inB[j]) {
      out += b[j] as string;
      i++;
      j++;
    }
  }
  return out;
}
