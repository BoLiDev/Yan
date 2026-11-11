import { marked, type Token, type TokensList } from 'marked';
import { cleaned, finished, type MarkdownContext, type RenderedMarkdown } from './markdown';
import { alike, kept, mergeWords } from './words';

/**
 * One version of a Markdown text against the one before, drawn as the
 * document it is and not as its source: the blocks both have as they are,
 * a block only the new has marked as added, one only the old has kept in
 * its place and marked as taken out, and a block that was changed drawn
 * once, the words taken out of it and put into it marked where they are.
 * Or the two side by side, block beside block: the old on the left with
 * what was taken out of it marked, the new on the right with what was put
 * in, a block only one has facing nothing.
 */

/** A block of the text as it is drawn: one of a version's own, or a changed one, as the old had it and as the new has it. */
type Piece =
  | { readonly mark: null | 'add' | 'del'; readonly tok: Token; readonly from: 'old' | 'new' }
  | { readonly mark: 'mod'; readonly old: string; readonly now: string };

/** Which of a changed block is written: the new with what the old had written in, or either alone with its own marks. */
type Side = 'both' | 'old' | 'new';

/** The blocks a changed one may be told word by word in: the ones that are prose, a line at a time. A table's or a fence's lines are not. */
const PROSE = new Set(['paragraph', 'heading', 'list', 'blockquote']);

/** A changed block has this much of the old in it; less, and it is another block in the old one's place. */
const ALIKE = 0.34;

/** What a line begins with that is not its words: a list's mark and its box, a quote's, a heading's, and the space before them. */
const LEAD = /^(?:\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?|#{1,6}\s+))*\s*/;

const split = (line: string): [string, string] => {
  const lead = LEAD.exec(line)?.[0] ?? '';
  return [lead, line.slice(lead.length)];
};
const wrap = (tag: 'ins' | 'del') => (s: string): string => (s.trim() === '' ? s : `<${tag}>${s}</${tag}>`);

/**
 * A changed block's source, the new one's with what the old had written
 * in: line by line, a line both have as it is, a line that took another's
 * place with the words changed marked, a line only one has marked whole,
 * each after what it begins with, so a list is still a list. For one
 * `side` alone, that version's lines, with only what the other lacks marked.
 */
function mergedSource(old: string, now: string, side: Side): string {
  const none = (): string => '';
  const [del, ins] = [side === 'new' ? none : wrap('del'), side === 'old' ? none : wrap('ins')];
  const [a, b] = [old.replace(/\n+$/, '').split('\n'), now.replace(/\n+$/, '').split('\n')];
  const [inA, inB] = kept(a, b);
  const out: string[] = [];
  const whole = (line: string, tag: 'ins' | 'del'): void => {
    const [lead, body] = split(line);
    if (body.trim() !== '') out.push(lead + wrap(tag)(body));
  };
  for (let i = 0, j = 0; i < a.length || j < b.length;) {
    let [x, y] = [i, j];
    while (x < a.length && !inA[x]) x++;
    while (y < b.length && !inB[y]) y++;
    const [gone, come] = [a.slice(i, x), b.slice(j, y)];
    for (let k = 0; k < Math.max(gone.length, come.length); k++) {
      const [g, c] = [gone[k], come[k]];
      if (g !== undefined && c !== undefined && alike(split(g)[1], split(c)[1]) >= ALIKE) {
        const [lead, body] = split(side === 'old' ? g : c);
        out.push(lead + mergeWords(split(g)[1], side === 'old' ? split(c)[1] : body, del, ins));
      } else {
        if (g !== undefined && side !== 'new') whole(g, 'del');
        if (c !== undefined && side !== 'old') whole(c, 'ins');
      }
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

/** The blocks to draw for `now` against `old`, in the order of the new text, what was taken out where it was. */
function piecesOf(old: readonly Token[], now: readonly Token[]): Piece[] {
  const said = (toks: readonly Token[]): Token[] => toks.filter((t) => t.type !== 'space');
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
      if (g !== undefined && c !== undefined && g.type === c.type && PROSE.has(c.type) && alike(g.raw, c.raw) >= ALIKE) {
        out.push({ mark: 'mod', old: g.raw, now: c.raw });
      } else {
        if (g !== undefined) out.push({ mark: 'del', tok: g, from: 'old' });
        if (c !== undefined) out.push({ mark: 'add', tok: c, from: 'new' });
      }
    }
    [i, j] = [x, y];
    if (j < b.length) {
      out.push({ mark: null, tok: b[j] as Token, from: 'new' });
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
    const toks = p.mark === 'mod' ? marked.lexer(mergedSource(p.old, p.now, side), { gfm: true }) : (Object.assign([p.tok], { links: (p.from === 'old' ? was : is).links }) as TokensList);
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
    const [left, right] = [el({ side: 'old' }), el({ side: 'new' })];
    if (p.mark !== 'add') left.append(...drawn(p, 'old'));
    if (p.mark !== 'del') right.append(...drawn(p, 'new'));
    const row = el({ row: '' });
    row.append(left, right);
    doc.append(row);
  }
  return { ...finished(doc, ctx), changed: all.filter((p) => p.mark !== null).length };
}
