import { cells, columnsOf, fit } from '../shared/style.js';

/**
 * A paragraph broken into lines of a given width, for text in English and in
 * Chinese alike. Text breaks only between units: a run of narrow non-space
 * characters (a word, `4-7-8`, a path), or one wide character. Closing
 * punctuation sticks to the unit before it and opening punctuation to the one
 * after it, so no line starts with `。` or ends with `（`.
 */

const NO_LINE_START = new Set([...'，。、；：？！）」』】》〉’”…,.;:?!)]}']);
const NO_LINE_END = new Set([...'（「『【《〈‘“([{']);

const wide = (char: string | undefined): boolean => char !== undefined && columnsOf(char) === 2;

/** A piece of text never broken, and whether a space came before it. */
interface Unit {
  text: string;
  space: boolean;
}

export type Line = readonly Unit[];

function units(text: string): Unit[] {
  const out: Unit[] = [];
  let space = false;
  let glueNext = false;
  for (const char of text) {
    if (/\s/.test(char)) {
      space = true;
      glueNext = false;
      continue;
    }
    const last = out[out.length - 1];
    const lastChar = last === undefined ? undefined : [...last.text].pop();
    const continuesWord = !space && last !== undefined && !wide(char) && !wide(lastChar);
    const sticks = !space && last !== undefined && (NO_LINE_START.has(char) || glueNext);
    if (last !== undefined && (continuesWord || sticks)) last.text += char;
    else out.push({ text: char, space });
    glueNext = NO_LINE_END.has(char);
    space = false;
  }
  return out;
}

/** Greedy wrap to `width` columns. A unit wider than the line (a URL) is cut at the edge. */
export function wrap(text: string, width: number): Line[] {
  const lines: Unit[][] = [];
  let line: Unit[] = [];
  let used = 0;
  const flush = (): void => {
    lines.push(line);
    line = [];
    used = 0;
  };
  for (const unit of units(text)) {
    let u = unit;
    for (;;) {
      const lead = line.length > 0 && u.space ? 1 : 0;
      const w = cells(u.text);
      if (used + lead + w <= width) {
        line.push({ text: u.text, space: lead === 1 });
        used += lead + w;
        break;
      }
      if (line.length > 0) {
        flush();
        continue;
      }
      let head = '';
      let headCells = 0;
      const chars = [...u.text];
      while (chars.length > 0 && headCells + columnsOf(chars[0] as string) <= width) {
        headCells += columnsOf(chars[0] as string);
        head += chars.shift();
      }
      if (head === '') head = chars.shift() ?? ''; // narrower than one wide character: never loop
      line.push({ text: head, space: false });
      flush();
      if (chars.length === 0) break;
      u = { text: chars.join(''), space: false };
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

/** A wrapped line as text; a space between units is kept inside a line and dropped at a break. */
export function lineText(line: Line): string {
  return line.map((u, i) => (i > 0 && u.space ? ' ' : '') + u.text).join('');
}

/**
 * At most `max` lines. When text is left over, or `more` says further
 * paragraphs follow, the last line gives up whole units until `…` fits, loses
 * trailing whitespace and punctuation, and ends in `…` with no space before it.
 */
export function clamp(lines: readonly Line[], max: number, width: number, more = false): string[] {
  if (lines.length <= max && !more) return lines.map(lineText);
  const kept = lines.slice(0, max);
  const last = [...(kept[kept.length - 1] ?? [])];
  while (last.length > 1 && cells(lineText(last)) + 1 > width) last.pop();
  const text = lineText(last).replace(/[.,;:!?，。、；：！？\s]+$/u, '');
  return [...kept.slice(0, -1).map(lineText), `${fit(text, width - 1)}…`];
}
