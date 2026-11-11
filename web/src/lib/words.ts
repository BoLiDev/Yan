import type { PatchFile, PatchLine } from './patch';

/**
 * What changed inside a line, for a diff of prose: a paragraph of Markdown
 * is one line, so a line taken out and a line put in its place say only
 * that something in the paragraph changed. Each such pair is compared word
 * by word, and what only the old has is wrapped in `<del>` there, what only
 * the new has in `<ins>`, in the line's HTML (`h`), which the diff draws.
 */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A line as what is compared: words in Latin letters and digits whole, a run of spaces, and any other character, a Chinese one or a mark, on its own. */
const pieces = (s: string): string[] => s.match(/[\p{Script=Latin}\p{N}_]+|\s+|[\s\S]/gu) ?? [];

/** Past this many cells, the table two lines are compared in is not built, and only what they begin and end alike is taken as kept. */
const CELLS = 4_000_000;

/** Which of `a`'s pieces and of `b`'s are in both, in order: the longest such run of them. */
function kept(a: readonly string[], b: readonly string[]): [boolean[], boolean[]] {
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

/** A line's pieces as HTML, each run not kept wrapped in `tag`. */
function marked(all: readonly string[], keep: readonly boolean[], tag: 'ins' | 'del'): string {
  let out = '';
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j < all.length && keep[j] === keep[i]) j++;
    const run = esc(all.slice(i, j).join(''));
    out += keep[i] ? run : `<${tag}>${run}</${tag}>`;
    i = j;
  }
  return out;
}

/**
 * An old line and the new one in its place, each as HTML with what the
 * other lacks marked; null when they have too little in common for marks
 * to say anything the two lines do not.
 */
export function wordDiff(old: string, now: string): [string, string] | null {
  const [a, b] = [pieces(old), pieces(now)];
  const [inA, inB] = kept(a, b);
  const said = (all: readonly string[], keep: readonly boolean[]): number => all.filter((p, i) => keep[i] && p.trim() !== '').length;
  const words = (all: readonly string[]): number => all.filter((p) => p.trim() !== '').length;
  if (said(a, inA) * 3 < Math.max(words(a), words(b))) return null;
  return [marked(a, inA, 'del'), marked(b, inB, 'ins')];
}

/** Mark, in place, what changed inside each line of `f` that another took the place of: the nth taken out of a run with the nth put in. */
export function markWords(f: PatchFile): void {
  for (const hk of f.hunks) {
    let dels: PatchLine[] = [];
    let adds: PatchLine[] = [];
    const flush = (): void => {
      for (let i = 0; i < Math.min(dels.length, adds.length); i++) {
        const [d, a] = [dels[i] as PatchLine, adds[i] as PatchLine];
        const pair = wordDiff(d.t, a.t);
        if (pair !== null) [d.h, a.h] = pair;
      }
      dels = [];
      adds = [];
    };
    for (const l of hk.lines) {
      if (l.k === 'del') {
        if (adds.length) flush();
        dels.push(l);
      } else if (l.k === 'add') adds.push(l);
      else flush();
    }
    flush();
  }
}
