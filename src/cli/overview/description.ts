import { columnsOf } from '../shared/style.js';

/**
 * What a task is for, as its `brief.md` says it: the text under
 * `## Description`, up to the next heading of that level or above; with no
 * such heading, the first paragraph after the `# title` line; `null` when
 * there is neither.
 *
 * `brief.md` is hard-wrapped, so each paragraph comes back as one line and
 * paragraphs are separated by one blank line (`\n\n`). Markdown is not
 * parsed: backticks and the rest stay as typed.
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
    const start = rest.findIndex((l) => l.trim() !== '');
    if (start < 0 || /^#{1,6}\s/.test(rest[start] ?? '')) return null;
    const para = rest.slice(start);
    const end = para.findIndex((l) => l.trim() === '' || /^#{1,6}\s/.test(l));
    body = end < 0 ? para : para.slice(0, end);
  }

  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of [...body, '']) {
    if (line.trim() === '') {
      if (current.length > 0) paragraphs.push(unwrapParagraph(current.join('\n')));
      current = [];
    } else {
      current.push(line);
    }
  }
  const text = paragraphs.filter((p) => p !== '').join('\n\n');
  return text === '' ? null : text;
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
