// A title found by the pinyin of its Chinese characters, as it is typed without an input method:
// `zhongwen jijian`, `zhongwenjijian` or the initials `zwjj` for 中文基建.

import TinyPinyin from 'tiny-pinyin';

/** A character of a title: where it is, and its pinyin when it is Chinese, in lower case. */
interface Char {
  readonly at: number;
  readonly end: number;
  readonly pinyin: string | null;
}

const read = new Map<string, readonly Char[]>();

/**
 * `text`, a character at a time, each Chinese one with its pinyin. One
 * reading a character: a character read two ways is found by its commonest
 * (重 by `zhong`, in 重庆 too). Kept by text, since the same titles are
 * matched at every letter typed.
 */
function charsOf(text: string): readonly Char[] {
  const known = read.get(text);
  if (known !== undefined) return known;
  const chars: Char[] = [];
  let at = 0;
  for (const part of TinyPinyin.isSupported() ? TinyPinyin.parse(text) : []) {
    // Type 2 is a character it gave a pinyin to.
    chars.push({ at, end: at + part.source.length, pinyin: part.type === 2 ? part.target.toLowerCase() : null });
    at += part.source.length;
  }
  if (read.size > 2000) read.clear();
  read.set(text, chars);
  return chars;
}

/**
 * Where the letters `typed` end, read as pinyin from the character at `k`
 * on: each character taken by its whole syllable or by its initial alone,
 * the last by as much of its syllable as was typed. The index after the
 * last character taken, with whether every one was typed in full; undefined
 * when the letters do not read as these characters.
 */
function reads(chars: readonly Char[], k: number, typed: string): { end: number; whole: boolean } | undefined {
  if (typed === '') return { end: k, whole: true };
  const syllable = chars[k]?.pinyin;
  if (syllable === undefined || syllable === null) return undefined;
  if (typed.startsWith(syllable)) {
    const rest = reads(chars, k + 1, typed.slice(syllable.length));
    if (rest !== undefined) return rest;
  }
  // The last character typed in part: `zhongw` for 中文.
  if (typed.length > 1 && syllable.startsWith(typed)) return { end: k + 1, whole: false };
  if (typed[0] === syllable[0]) {
    const rest = reads(chars, k + 1, typed.slice(1));
    if (rest !== undefined) return { end: rest.end, whole: false };
  }
  return undefined;
}

/**
 * Where in `text` the letters `typed`, lower case, read as the pinyin of a
 * run of its Chinese characters, the earliest such run: its [start, end) in
 * the text, whether it starts the text, and whether every character was
 * typed in full rather than by its initial. Undefined when there is none,
 * when `typed` is not letters alone, or the text has no Chinese in it.
 */
export function pinyinAt(text: string, typed: string): { range: [number, number]; first: boolean; whole: boolean } | undefined {
  if (!/^[a-z]+$/.test(typed) || !/\p{Script=Han}/u.test(text)) return undefined;
  const chars = charsOf(text);
  for (let k = 0; k < chars.length; k++) {
    if (chars[k]?.pinyin == null) continue;
    const found = reads(chars, k, typed);
    if (found !== undefined) return { range: [(chars[k] as Char).at, (chars[found.end - 1] as Char).end], first: k === 0, whole: found.whole };
  }
  return undefined;
}
