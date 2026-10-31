import { Fragment, type ReactNode } from 'react';
import { splitPairs, type PatchFile, type PatchLine } from '../../lib/patch';
import { cn } from '../../lib/utils';
import { CodeText } from '../Code';
import { Later } from './Later';

const DIFF_LIMIT = 5000;
/** A line of a diff is this tall unless it wraps: what a part not drawn yet holds for it. */
export const LINE_PX = 21;
/** The lines drawn together once they come near. */
const CHUNK = 200;

/** A file's diff as a card, its lines in code's face at the height LINE_PX holds for them. */
export const DIFF = 'mb-[18px] overflow-hidden rounded-[12px] bg-card font-mono text-[12.5px]/[21px] ring-1 ring-border';

type Kind = PatchLine['k'] | 'hunk';
/** A line's ground by what it is, a hunk's head in teal, and its numbers' a shade deeper. */
const GROUND: Record<Kind, string> = { ctx: '', hunk: 'bg-[var(--diff-hunk)] text-brand', del: 'bg-[var(--diff-del)]', add: 'bg-[var(--diff-add)]' };
const GUTTER: Record<Kind, string> = { ctx: 'bg-[var(--code-bg)]', hunk: 'bg-[var(--diff-hunk-gutter)]', del: 'bg-[var(--diff-del-gutter)]', add: 'bg-[var(--diff-add-gutter)]' };
const SIGN: Record<Kind, string> = { ctx: '', hunk: '', del: 'text-destructive', add: 'text-success' };
/** A line's number, kept out of a selection, so what is copied is the code alone. */
const NUMBER = 'w-[50px] flex-none pr-2 text-right text-ink-4 select-none';
/** A line's text, wrapped where it is too long for the card rather than scrolled. */
const TEXT = 'min-w-0 flex-auto whitespace-pre-wrap wrap-anywhere';

/** A line of the unified diff: its number on each side, + or −, and its text. */
function Line({ k, a, b, children }: { k: Kind; a?: number; b?: number; children: ReactNode }) {
  return (
    <div className={cn('flex', GROUND[k])}>
      <span className={cn(NUMBER, GUTTER[k])}>{a ?? ''}</span>
      <span className={cn(NUMBER, GUTTER[k])}>{b ?? ''}</span>
      <span className={cn('w-[18px] flex-none text-center select-none', SIGN[k])}>{k === 'add' ? '+' : k === 'del' ? '−' : ''}</span>
      {children}
    </div>
  );
}

/** What a file's diff says instead of lines, in the page's own face. */
function Say({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex', className)}><span className={cn(TEXT, 'px-3.5 py-2.5 font-sans')}>{children}</span></div>;
}

/** One side of a pair side by side: the right one is set off from the left by a line; a side with no line is code's ground. */
function Half({ l, side }: { l: PatchLine | null; side: 'a' | 'b' }) {
  const half = cn('flex min-w-0', side === 'b' && 'border-l', l ? GROUND[l.k] : 'bg-[var(--code-bg)]');
  const number = cn(NUMBER, 'bg-[var(--gutter)]');
  const text = cn(TEXT, 'pr-3 pl-2');
  if (!l) return <div className={half}><span className={number} /><span className={text} /></div>;
  return (
    <div className={half}>
      <span className={number}>{side === 'a' ? l.a ?? '' : l.b ?? ''}</span>
      <CodeText className={text} text={l.t} html={l.h} />
    </div>
  );
}

/** How many lines a file's diff shows, its hunks' heads among them, for the height it holds before it is drawn. */
export function linesOf(f: PatchFile): number {
  return Math.max(1, Math.min(DIFF_LIMIT + 1, f.hunks.reduce((n, hk) => n + 1 + hk.lines.length, 0)));
}

/** A file's changes, unified or side by side, cut past 5,000 lines, drawn a part at a time as they come near. */
export function DiffBody({ f, layout }: { f: PatchFile; layout: 'unified' | 'split' }) {
  if (f.binary) return <Say>A binary file: no lines to compare.</Say>;
  if (!f.hunks.length) return <Say>{f.note.length ? `${f.note.join(', ')}, empty` : 'Only the mode changed.'}</Say>;
  let count = 0;
  // One entry a line of the page: a pair side by side is one, in the grid as its two halves.
  const rows: ReactNode[] = [];
  f.hunks.forEach((hk, h) => {
    if (count > DIFF_LIMIT) return;
    if (layout === 'split') {
      rows.push(<div className={cn('col-span-full pl-[58px]', GROUND.hunk)} key={`h${h}`}>{hk.head}</div>);
      splitPairs(hk.lines).forEach(([l, r], i) => {
        rows.push(<Fragment key={`${h}:${i}`}><Half l={l} side="a" /><Half l={r} side="b" /></Fragment>);
        count++;
      });
    } else {
      rows.push(<Line k="hunk" key={`h${h}`}><span className={cn(TEXT, 'pr-4')}>{hk.head}</span></Line>);
      hk.lines.forEach((l, i) => {
        rows.push(<Line k={l.k} a={l.a} b={l.b} key={`${h}:${i}`}><CodeText className={cn(TEXT, 'pr-4')} text={l.t} html={l.h} /></Line>);
        count++;
      });
    }
    if (count > DIFF_LIMIT) rows.push(<Say className="col-span-full text-ink-3" key="cut">{`Cut at ${DIFF_LIMIT.toLocaleString()} lines.`}</Say>);
  });
  const grid = layout === 'split' ? 'grid grid-cols-2' : undefined;
  if (rows.length <= CHUNK) return <div className={grid}>{rows}</div>;
  const parts: ReactNode[] = [];
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    parts.push(<Later key={i} height={part.length * LINE_PX} className={grid} eager={i === 0}>{() => part}</Later>);
  }
  return <div>{parts}</div>;
}
