import { columnsOf } from '../shared/style.js';

/**
 * What a task is for, as its `brief.md` says it.
 *
 * A brief is the title line and short prose: everything under the title, up
 * to the first heading. An older brief put that prose under a
 * `## Description` heading, and one that still has the heading is read as it
 * always was — the text under it, up to the next heading of that level or
 * above. `null` when there is neither.
 *
 * `brief.md` is hard-wrapped, so each paragraph comes back as one line and
 * paragraphs are separated by one blank line (`\n\n`). A bullet keeps its own
 * line rather than being folded into the paragraph before it, so a list still
 * reads as a list. Markdown is not parsed: backticks and the rest stay as
 * typed.
 */
export function briefDescription(brief: string): string | null {
  const lines = brief.replace(/\r/g, '').split('\n');
  const heading = lines.findIndex((l) => /^##\s+Description\s*$/i.test(l));

  let body: string[];
  if (heading >= 0) {
    const rest = lines.slice(heading + 1);
    const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
    body = end < 0 ? rest : rest.slice(0, end);
  } else {
    const title = lines.findIndex((l) => /^#\s/.test(l));
    if (title < 0) return null;
    const rest = lines.slice(title + 1);
    const end = rest.findIndex((l) => /^#{1,6}\s/.test(l));
    body = end < 0 ? rest : rest.slice(0, end);
  }

  const blocks = blocksOf(body);
  if (blocks.length === 0) return null;

  // A bullet joins what is above it with a single newline, so a list stays a
  // list; everything else is a paragraph, and paragraphs are a blank line
  // apart.
  let text = '';
  blocks.forEach((block, i) => {
    if (i > 0) text += block.bullet ? '\n' : '\n\n';
    text += block.text;
  });
  return text === '' ? null : text;
}

interface Block {
  readonly bullet: boolean;
  readonly text: string;
}

/**
 * The body as blocks: a paragraph, or one bullet with whatever wrapped lines
 * belong to it. A blank line ends a block and a bullet starts one.
 */
function blocksOf(body: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let bullet = false;
  let current: string[] = [];
  const flush = (): void => {
    const text = unwrapParagraph(current.join('\n'));
    if (text !== '') blocks.push({ bullet, text });
    current = [];
    bullet = false;
  };

  for (const line of [...body, '']) {
    if (line.trim() === '') {
      flush();
    } else if (isBullet(line)) {
      flush();
      bullet = true;
      current.push(line);
    } else {
      current.push(line);
    }
  }
  return blocks;
}

/** `- `, `* `, `+ ` or `1. `, at any indent. */
export function isBullet(line: string): boolean {
  return /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line);
}

const wide = (char: string | undefined): boolean => char !== undefined && columnsOf(char) === 2;

/**
 * One hard-wrapped paragraph as one line: each line trimmed, joined with a
 * space, except between two wide characters, which join with nothing, and
 * runs of whitespace collapsed.
 */
export function unwrapParagraph(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== '');
  let out = '';
  for (const line of lines) {
    if (out === '') out = line;
    else out += (wide([...out].pop()) && wide([...line][0]) ? '' : ' ') + line;
  }
  return out.replace(/\s+/g, ' ');
}
