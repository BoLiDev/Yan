import { wide } from '../shared/style.js';

/**
 * A `brief.md` as the work report shows it: each hard-wrapped paragraph as one
 * line, paragraphs a blank line apart, a bullet on a line of its own so a list
 * still reads as one, and a heading a paragraph of its own without its `#`s.
 * Markdown is not otherwise parsed. A leading `# ` title line, which briefs
 * carried before v4, is left out. `null` for an empty brief.
 */
export function briefProse(brief: string): string | null {
  let lines = brief.replace(/^\uFEFF/, '').replace(/\r/g, '').split('\n');
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first >= 0 && /^#\s/.test(lines[first] as string)) lines = lines.slice(first + 1);

  let text = '';
  for (const block of blocksOf(lines)) {
    if (text !== '') text += block.bullet ? '\n' : '\n\n';
    text += block.text;
  }
  return text === '' ? null : text;
}

interface Block {
  readonly bullet: boolean;
  readonly text: string;
}

/** A blank line ends a block and a bullet starts one. */
function blocksOf(body: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let bullet = false;
  let current: string[] = [];
  const flush = (): void => {
    const text = unwrap(current);
    if (text !== '') blocks.push({ bullet, text });
    current = [];
    bullet = false;
  };
  for (const line of [...body, '']) {
    if (line.trim() === '') {
      flush();
    } else if (/^#{1,6}\s/.test(line)) {
      flush();
      current.push(line.replace(/^#+\s*/, ''));
      flush();
    } else if (/^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line)) {
      flush();
      bullet = true;
      current.push(line);
    } else {
      current.push(line);
    }
  }
  return blocks;
}

/** Lines joined with a space, except between two wide characters, which join with nothing. */
function unwrap(lines: readonly string[]): string {
  let out = '';
  for (const line of lines.map((l) => l.trim()).filter((l) => l !== '')) {
    if (out === '') out = line;
    else out += (wide([...out].pop()) && wide([...line][0]) ? '' : ' ') + line;
  }
  return out.replace(/\s+/g, ' ');
}
