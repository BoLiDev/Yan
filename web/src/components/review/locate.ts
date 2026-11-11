/**
 * Where a selection is, as a reader would find it and an agent is told it:
 * the lines of a Markdown file its rendered text came from, or the lines of
 * a file of code, a diff's among them, by the numbers drawn beside them; or
 * the change of a Markdown file's history it was read in.
 */

/** What a comment says of where it is: the words for it, and whether what was selected is code. */
export interface Located {
  readonly where: string;
  readonly code: boolean;
}

/** `line 4`, or `lines 4-9`. */
const span = (from: number, to: number): string => (to > from ? `lines ${from}-${to}` : `line ${from}`);

/**
 * The lines of a Markdown source a selection in its rendered text covers,
 * counted from 0, `to` the line after the last: read off the marks before
 * each block (`renderMarkdown`'s `lines`), so to the block, not the line.
 */
export function sourceLines(box: Element, range: Range, total: number): { from: number; to: number } | null {
  const marks = [...box.querySelectorAll<HTMLElement>('[data-line]')];
  if (marks.length === 0) return null;
  const before = (m: Element, node: Node): boolean => (m.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  let first = 0;
  while (first + 1 < marks.length && before(marks[first + 1] as Element, range.startContainer)) first++;
  let last = first;
  // A selection that ends at the very start of a block ends in the one before it.
  const end = range.endOffset === 0 && range.endContainer !== range.startContainer ? range.startContainer : range.endContainer;
  while (last + 1 < marks.length && before(marks[last + 1] as Element, end)) last++;
  const next = marks[last + 1];
  return { from: Number((marks[first] as HTMLElement).dataset.line), to: next ? Number(next.dataset.line) : total };
}

/** A selection in a rendered Markdown file, `path` from the task's folder: by the lines of its source. */
export function inMarkdown(path: string, box: Element, range: Range, text: string): Located {
  const at = sourceLines(box, range, text.split('\n').length);
  if (at === null) return { where: path, code: false };
  // The line after the last block's is the blank one between it and the next.
  const lines = text.split('\n');
  let to = at.to;
  while (to > at.from + 1 && (lines[to - 1] ?? '').trim() === '') to--;
  return { where: `${path}, ${span(at.from + 1, to)}`, code: false };
}

/** Where in a source's text the lines `from` to `to` are, and in them `quote` when it is there as it is written. */
export function spanInSource(text: string, at: { from: number; to: number }, quote: string): [number, number] {
  const lines = text.split('\n');
  const offset = (line: number): number => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  const [a, b] = [offset(at.from), Math.min(text.length, offset(at.to))];
  const part = text.slice(a, b);
  const found = quote.trim() === '' ? -1 : part.indexOf(quote.trim());
  if (found >= 0) return [a + found, a + found + quote.trim().length];
  return [a, a + part.replace(/\s+$/, '').length];
}

/** The row of code a node is in: one drawn with its numbers, `data-a` the old and `data-b` the new. */
const rowOf = (node: Node): HTMLElement | null => (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('[data-b], [data-a]') ?? null;

/**
 * A selection in a file of code or a diff, drawn in rows that carry their
 * numbers: its file, from the nearest `data-path` when `path` is not given,
 * and its lines, the new file's where the rows have them, the old one's for
 * lines taken out.
 */
export function inCode(prefix: string, range: Range, path?: string): Located {
  const [first, last] = [rowOf(range.startContainer), rowOf(range.endContainer)];
  const file = path ?? first?.closest<HTMLElement>('[data-path]')?.dataset.path ?? '';
  const head = [prefix, file].filter(Boolean).join(', ');
  if (first === null) return { where: head, code: true };
  const end = last ?? first;
  const [b1, b2] = [Number(first.dataset.b), Number(end.dataset.b)];
  if (b1 > 0 && b2 > 0) return { where: `${head}, ${span(b1, Math.max(b1, b2))}`, code: true };
  const [a1, a2] = [Number(first.dataset.a), Number(end.dataset.a)];
  if (a1 > 0 && a2 > 0) return { where: `${head}, removed ${span(a1, Math.max(a1, a2))} of the old file`, code: true };
  const one = b1 > 0 ? `line ${b1}` : a1 > 0 ? `removed line ${a1} of the old file` : '';
  return { where: [head, one && `from ${one}`].filter(Boolean).join(', '), code: true };
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * A selection in a change of a Markdown file's history, drawn as the
 * document: the file, `path` from the task's folder, and the change, by
 * its commit in the vault and when it was, on this machine's clock. No
 * lines: what is drawn is two versions as one, and its lines are neither's.
 * Words the change took out are said to be so, since they are no longer in
 * the file to be found, and so are words read in the version before.
 */
export function inChange(path: string, commit: string, at: number, range: Range): Located {
  const el = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
  const d = new Date(at * 1000);
  const when = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
  const gone = el?.closest('del, [data-diff=del]') ? ', text it removed' : el?.closest('[data-side=old]') ? ', as it read before the change' : '';
  return { where: `${path}, the change ${commit.slice(0, 7)} of ${when}${gone}`, code: false };
}
