import { marked, type Token, type TokensList } from 'marked';
import { blocksIn, cleaned, finished, leftOpen, rawOf, type MarkdownContext, type RenderedMarkdown } from './markdown';
import { alike, kept, mergeWords } from './words';

/**
 * One version of a Markdown text against the one before, drawn as the
 * document it is and not as its source: the blocks both have as they are,
 * a block only the new has marked as added, one only the old has kept in
 * its place and marked as taken out, and a block that was changed drawn
 * once, the words taken out of it and put into it marked where they are,
 * a table's in its cells. Or the two side by side, block beside block: the old on the left with
 * what was taken out of it marked, the new on the right with what was put
 * in, a block only one has facing nothing.
 */

/** A top-level block of a text: its source, what it is, and its pieces, more than one for HTML that blank lines run through. */
interface Block {
  readonly raw: string;
  readonly type: string;
  readonly toks: readonly Token[];
}

/** How a changed block's lines are marked: prose after what each begins with, a table's row a cell at a time, HTML between its tags. */
type Kind = 'prose' | 'table' | 'html';

/** A block of the text as it is drawn: one of a version's own, or a changed one, as the old had it and as the new has it. */
type Piece =
  | { readonly mark: null | 'add' | 'del'; readonly block: Block; readonly from: 'old' | 'new'; readonly facing?: boolean }
  | { readonly mark: 'mod'; readonly old: string; readonly now: string; readonly kind: Kind };

/** Which of a changed block is written: the new with what the old had written in, or either alone with its own marks. */
type Side = 'both' | 'old' | 'new';

/**
 * The blocks a changed one may be drawn once in, its changes marked inside
 * it: prose, a line at a time, and a table, a row and a cell at a time. A
 * fence's lines are code, where a mark would be read as more of it. HTML
 * written into the text, a table most often, is marked in the words
 * between its tags.
 */
const MARKED = new Set(['paragraph', 'heading', 'list', 'blockquote', 'table', 'html']);

/** A fence, on a line of its own or inside a list or a quote: a block that holds one is not marked inside. */
const FENCE = /^[\s>]*(?:[-*+]\s+|\d+[.)]\s+)?(?:```|~~~)/m;

/** A changed block has this much of the old in it; less, and it is another block in the old one's place. */
const ALIKE = 0.34;

/** What a line begins with that is not its words: a list's mark and its box, a quote's, a heading's, and the space before them. */
const LEAD = /^(?:\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?|#{1,6}\s+))*\s*/;

const split = (line: string): [string, string] => {
  const lead = LEAD.exec(line)?.[0] ?? '';
  return [lead, line.slice(lead.length)];
};
const wrap = (tag: 'ins' | 'del') => (s: string): string => (s.trim() === '' ? s : `<${tag}>${s}</${tag}>`);

/** The line under a table's head, `| --- | :-: |`: its shape, with no words to mark. */
const RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
/** A row's cells, with what is around them: the bars between are the table's, and a mark must stay inside a cell. */
const cellsOf = (row: string): string[] => row.split(/(?<!\\)\|/);
/** A cell with its words changed by `f`, the space around them kept. */
const inCell = (cell: string, f: (words: string) => string): string => (cell.trim() === '' ? cell : cell.replace(/^(\s*)([\s\S]*?)(\s*)$/, (_m, a: string, words: string, z: string) => a + f(words) + z));

/**
 * A changed block's source, the new one's with what the old had written
 * in: line by line, a line both have as it is, a line that took another's
 * place with the words changed marked, a line only one has marked whole,
 * each after what it begins with, so a list is still a list. A table's
 * row (`table`, or a line of bars inside a list or a quote) is marked a
 * cell at a time, so it is still a row. For one `side` alone, that
 * version's lines, with only what the other lacks marked.
 */
function mergedSource(old: string, now: string, side: Side, kind: Kind): string {
  const table = kind === 'table';
  const none = (): string => '';
  const [del, ins] = [side === 'new' ? none : wrap('del'), side === 'old' ? none : wrap('ins')];
  const [a, b] = [old.replace(/\n+$/, '').split('\n'), now.replace(/\n+$/, '').split('\n')];
  const [inA, inB] = kept(a, b);
  const out: string[] = [];
  const isRow = (body: string): boolean => table || /^\|.*\|\s*$/.test(body);
  /** A line of HTML as its tags and the words between them, the tags at the odd places. */
  const parts = (line: string): string[] => line.split(/(<[^>]+>)/);
  const words = (line: string, f: (s: string) => string): string => parts(line).map((p, k) => (k % 2 === 1 ? p : inCell(p, f))).join('');
  /** A line only one version has, marked whole; a table's rule is left out with the old and kept with the new. */
  const whole = (line: string, tag: 'ins' | 'del'): void => {
    if (kind === 'html') return void out.push(words(line, wrap(tag)));
    const [lead, body] = split(line);
    if (body.trim() === '') return;
    if (isRow(body) && RULE.test(body)) {
      if (tag === 'ins' || side === 'old') out.push(line);
    } else out.push(lead + (isRow(body) ? cellsOf(body).map((c) => inCell(c, wrap(tag))).join('|') : wrap(tag)(body)));
  };
  /** A line that took another's place, as one; false when the two are too unlike, or rows of different widths. */
  const pair = (g: string, c: string): boolean => {
    if (kind === 'html') {
      // The same line when its tags are the same: the words between them are compared, each with the one in its place.
      const [pa, pb] = [parts(g), parts(c)];
      if (pa.length !== pb.length || pa.some((p, k) => k % 2 === 1 && p !== pb[k])) return false;
      return out.push(pb.map((p, k) => {
        const [o, n] = [(pa[k] as string).trim(), p.trim()];
        if (k % 2 === 1 || o === n) return side === 'old' ? (pa[k] as string) : p;
        return alike(o, n) >= ALIKE ? mergeWords(o, n, del, ins) : del(o) + ins(n);
      }).join('')) > 0;
    }
    const [[, was], [lead, is]] = [split(g), split(side === 'old' ? g : c)];
    const to = split(c)[1];
    // A row is as like another as its cells are: the bars between them are in every row.
    const said = (body: string): string => (isRow(body) ? cellsOf(body).join(' ') : body);
    if (!isRow(was) && !isRow(to)) return alike(was, to) >= ALIKE && out.push(lead + mergeWords(was, to, del, ins)) > 0;
    const [ca, cb] = [cellsOf(was), cellsOf(to)];
    if (ca.length !== cb.length) return false;
    // A row is the row it was when it is still called the same, by its first cell, however much of the rest changed.
    const name = (cells: readonly string[]): string => cells.find((c) => c.trim() !== '')?.trim() ?? '';
    if (name(ca) !== name(cb) && alike(said(was), said(to)) < ALIKE) return false;
    if (RULE.test(was) || RULE.test(to)) return out.push(lead + is) > 0;
    const cells = cb.map((cell, k) => {
      const [o, n] = [(ca[k] as string).trim(), cell.trim()];
      if (o === n) return cell;
      const both = alike(o, n) >= ALIKE ? mergeWords(o, n, del, ins) : del(o) + ins(n);
      return both === '' ? ' ' : ` ${both} `;
    });
    return out.push(lead + cells.join('|')) > 0;
  };
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    let [x, y] = [i, j];
    while (x < a.length && !inA[x]) x++;
    while (y < b.length && !inB[y]) y++;
    const [gone, come] = [a.slice(i, x), b.slice(j, y)];
    for (let k = 0; k < Math.max(gone.length, come.length); k++) {
      const [g, c] = [gone[k], come[k]];
      if (g !== undefined && c !== undefined && pair(g, c)) continue;
      if (g !== undefined && side !== 'new') whole(g, 'del');
      if (c !== undefined && side !== 'old') whole(c, 'ins');
    }
    [i, j] = [x, y];
    if (j < b.length) {
      out.push(b[j] as string);
      i++;
      j++;
    }
  }
  return `${out.join('\n')}\n`;
}

const kindOf = (b: Block): Kind => (b.type === 'table' ? 'table' : b.type === 'html' ? 'html' : 'prose');

/**
 * Whether a block that took another's place is the same block changed, to
 * be drawn once: alike, of a kind marks can be written in, a table as wide
 * as it was, and HTML that still closes what it opens with the old and the
 * new written into one another, which a row put in or taken out half-way
 * would not.
 */
function changed(g: Block, c: Block): boolean {
  if (g.type !== c.type || !MARKED.has(c.type) || FENCE.test(g.raw) || FENCE.test(c.raw) || alike(g.raw, c.raw) < ALIKE) return false;
  if (c.type === 'html') return leftOpen(mergedSource(g.raw, c.raw, 'both', 'html')) === 0;
  return c.type !== 'table' || cellsOf(g.raw.split('\n')[0] ?? '').length === cellsOf(c.raw.split('\n')[0] ?? '').length;
}

/** The blocks to draw for `now` against `old`, in the order of the new text, what was taken out where it was. */
function piecesOf(old: readonly Token[], now: readonly Token[]): Piece[] {
  const said = (toks: readonly Token[]): Block[] => blocksIn(toks)
    .filter((block) => block.some((t) => t.type !== 'space'))
    .map((block) => ({ toks: block, raw: rawOf(block), type: (block[0] as Token).type }));
  const [a, b] = [said(old), said(now)];
  const [inA, inB] = kept(a.map((t) => t.raw.trim()), b.map((t) => t.raw.trim()));
  const out: Piece[] = [];
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    let [x, y] = [i, j];
    while (x < a.length && !inA[x]) x++;
    while (y < b.length && !inB[y]) y++;
    const [gone, come] = [a.slice(i, x), b.slice(j, y)];
    for (let k = 0; k < Math.max(gone.length, come.length); k++) {
      const [g, c] = [gone[k], come[k]];
      if (g !== undefined && c !== undefined && changed(g, c)) {
        out.push({ mark: 'mod', old: g.raw, now: c.raw, kind: kindOf(c) });
      } else {
        // One put in another's place: side by side, the new faces the old it took the place of.
        if (g !== undefined) out.push({ mark: 'del', block: g, from: 'old' });
        if (c !== undefined) out.push({ mark: 'add', block: c, from: 'new', facing: g !== undefined });
      }
    }
    [i, j] = [x, y];
    if (j < b.length) {
      out.push({ mark: null, block: b[j] as Block, from: 'new' });
      i++;
      j++;
    }
  }
  return out;
}

/**
 * `now` drawn against `old`, null for a first version, which is all new.
 * Each block is read on its own, in a holder that says what became of it
 * (`data-diff`: add, del or mod), so the page tints it; `changed` counts
 * them, none when the two texts draw alike. With `split`, every block is a
 * row (`data-row`) of two cells (`data-side`: old, new), so a block and
 * what became of it stand at the same height however long either is.
 */
export function renderMarkdownDiff(old: string | null, now: string, ctx: MarkdownContext = {}, split = false): RenderedMarkdown & { readonly changed: number } {
  const [was, is]: [TokensList, TokensList] = [marked.lexer(old ?? '', { gfm: true }), marked.lexer(now, { gfm: true })];
  const all = piecesOf(was, is);
  const doc = document.implementation.createHTMLDocument('').body;
  const el = (data: Record<string, string>): HTMLElement => {
    const div = doc.ownerDocument.createElement('div');
    Object.assign(div.dataset, data);
    return div;
  };
  /** A block as one side has it, in a holder when something became of it there. */
  const drawn = (p: Piece, side: Side): Node[] => {
    // A changed block is read anew from its marked source; any other is the version's own, with the links its text defines.
    const toks = p.mark === 'mod' ? marked.lexer(mergedSource(p.old, p.now, side, p.kind), { gfm: true }) : (Object.assign([...p.block.toks], { links: (p.from === 'old' ? was : is).links }) as TokensList);
    const one = cleaned(marked.parser(toks, { gfm: true }));
    if (p.mark === null) return [...one.childNodes];
    const holder = el({ diff: p.mark });
    holder.append(...one.childNodes);
    return [holder];
  };
  for (const p of all) {
    if (!split) {
      doc.append(...drawn(p, 'both'));
      continue;
    }
    // A block put in another's place goes in the row of the one it took the place of, which is the row before it.
    if (p.mark === 'add' && p.facing === true) {
      doc.lastElementChild?.querySelector(':scope > [data-side=new]')?.append(...drawn(p, 'new'));
      continue;
    }
    const [left, right] = [el({ side: 'old' }), el({ side: 'new' })];
    if (p.mark !== 'add') left.append(...drawn(p, 'old'));
    if (p.mark !== 'del') right.append(...drawn(p, 'new'));
    const row = el({ row: '' });
    row.append(left, right);
    doc.append(row);
  }
  return { ...finished(doc, ctx), changed: all.filter((p) => p.mark !== null).length };
}
