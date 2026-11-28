/*
 * PROTOTYPE. The path drawn as a graph, in a drawer under the page's main
 * area: a node for each step, shaped by its kind, a line from each step to
 * the steps that rely on it, and the destination at the end. Time and
 * dependency both run left to right. A first take only: how a path is drawn
 * is its own ticket.
 */
import { FileText, FlaskConical, Hammer, Search, Signpost, type LucideIcon } from 'lucide-react';
import { Icon } from '@/components/Icon';
import { SHIMMER, Tool } from '@/components/page';
import { cn } from '@/lib/utils';
import { CHANGE, LAST, OUTCOMES, STEPS, type MockStep, type StepKind, type StepState } from './data';

const W = 158, H = 58, GX = 30, GY = 22, PAD = 20;
const x = (col: number): number => PAD + col * (W + GX);
const y = (row: number): number => PAD + row * (H + GY);
const END_COL = Math.max(...STEPS.map((s) => s.col)) + 1;

/** A kind's mark and the shape its tile is cut to: a decision a diamond, research a circle, a prototype a dashed square, a spec a page, a build a hexagon. */
const KINDS: Record<StepKind, { word: string; Mark: LucideIcon; shape: string }> = {
  decision: { word: 'Decision', Mark: Signpost, shape: '[clip-path:polygon(50%_0,100%_50%,50%_100%,0_50%)]' },
  research: { word: 'Research', Mark: Search, shape: 'rounded-full' },
  prototype: { word: 'Prototype', Mark: FlaskConical, shape: 'rounded-[9px]' },
  spec: { word: 'Spec', Mark: FileText, shape: '[clip-path:polygon(0_0,68%_0,100%_32%,100%_100%,0_100%)] rounded-[4px]' },
  build: { word: 'Build', Mark: Hammer, shape: '[clip-path:polygon(25%_3%,75%_3%,100%_50%,75%_97%,25%_97%,0_50%)]' },
};

const TONE: Record<StepState, { tile: string; card: string; line: string }> = {
  done: { tile: 'bg-success-soft text-success', card: 'bg-card ring-border', line: 'var(--green)' },
  working: { tile: 'bg-brand text-[var(--card)]', card: 'bg-brand-wash ring-brand', line: 'var(--brand)' },
  ready: { tile: 'bg-hover text-ink-2', card: 'bg-card ring-border', line: 'var(--ink-4)' },
  waiting: { tile: 'bg-hover text-ink-4', card: 'bg-transparent ring-border [--tw-ring-color:var(--line)] outline-dashed outline-1 -outline-offset-1 outline-[var(--ink-4)] ring-0', line: 'var(--ink-4)' },
  dropped: { tile: 'bg-hover text-ink-4', card: 'bg-transparent ring-border opacity-60', line: 'var(--ink-4)' },
};

function Node({ s, onFile }: { s: MockStep; onFile: (path: string) => void }) {
  const k = KINDS[s.kind];
  const t = TONE[s.state];
  const first = s.files[0];
  return (
    <button type="button" title={`${k.word} · ${s.state}${first ? ' · opens what it left' : ''}`} onClick={() => { if (first) onFile(first); }}
      className={cn('absolute flex cursor-pointer items-center gap-2.5 rounded-[12px] px-2.5 text-left ring-1 hover:brightness-110', t.card)} style={{ left: x(s.col), top: y(s.row), width: W, height: H }}>
      <span className={cn('flex size-[30px] flex-none items-center justify-center', k.shape, t.tile, s.kind === 'prototype' && 'outline-dashed outline-1 -outline-offset-2 outline-current')}><k.Mark size={14} strokeWidth={2} aria-hidden="true" /></span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[10.5px]/[14px] font-bold tracking-wide text-ink-3 uppercase">{k.word}{s.state === 'working' ? <span className="text-brand"> · in work</span> : s.state === 'ready' ? ' · ready' : s.state === 'waiting' ? ' · waiting' : s.state === 'dropped' ? ' · dropped' : ''}</span>
        <span className={cn('line-clamp-2 text-[12.5px]/[16px]', s.state === 'working' && SHIMMER, s.state === 'dropped' && 'line-through', (s.state === 'waiting' || s.state === 'dropped') && 'text-ink-3')}>{s.title}</span>
      </span>
    </button>
  );
}

/** A line from the right edge of one box to the left edge of another, bending once between their columns. */
function edge(fromCol: number, fromRow: number, toCol: number, toRow: number): string {
  const x1 = x(fromCol) + W, y1 = y(fromRow) + H / 2, x2 = x(toCol), y2 = y(toRow) + H / 2;
  const mid = x2 - GX / 2;
  return `M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}`;
}

export function PathDrawer({ onClose, onFile }: { onClose: () => void; onFile: (path: string) => void }) {
  const at = (id: string): MockStep => STEPS.find((s) => s.id === id) as MockStep;
  const met = OUTCOMES.filter(([, ok]) => ok).length;
  const dropped = at(CHANGE.dropped);
  const width = x(END_COL) + W + PAD;
  const height = y(2) + H + PAD;
  return (
    <section className="flex h-[348px] flex-none flex-col border-t bg-background" aria-label="Path">
      <div className="flex h-11 flex-none items-center gap-4 pr-2 pl-5">
        <b className="text-[15px]">Path</b>
        <span className="text-[12px] text-ink-3 tabular-nums">{STEPS.filter((s) => s.state === 'done').length} of {STEPS.filter((s) => s.state !== 'dropped').length} steps done · 1 change</span>
        <span className="flex-1" />
        <span className="flex items-center gap-3.5 text-[12px] text-ink-3">
          {(Object.keys(KINDS) as StepKind[]).map((kind) => {
            const k = KINDS[kind];
            return <span key={kind} className="flex items-center gap-1.5"><span className={cn('flex size-[18px] items-center justify-center bg-hover text-ink-2', k.shape, kind === 'prototype' && 'rounded-[5px] outline-dashed outline-1 -outline-offset-2 outline-current')}><k.Mark size={10} strokeWidth={2.2} aria-hidden="true" /></span>{k.word}</span>;
          })}
        </span>
        <Tool name="close" label="Close the path (Ctrl+P)" onClick={onClose} small />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width, height }}>
          <svg className="absolute inset-0" width={width} height={height} aria-hidden="true">
            {STEPS.flatMap((s) => s.on.map((from) => {
              const f = at(from);
              const faint = s.state === 'dropped';
              return <path key={`${from}>${s.id}`} d={edge(f.col, f.row, s.col, s.row)} fill="none" stroke={faint ? 'var(--ink-4)' : TONE[s.state === 'done' || s.state === 'working' ? 'done' : 'ready'].line} strokeWidth={1.6} strokeDasharray={s.state === 'waiting' || faint ? '4 4' : undefined} opacity={faint ? 0.6 : 1} />;
            }))}
            {LAST.map((id) => <path key={id} d={edge(at(id).col, at(id).row, END_COL, 1)} fill="none" stroke="var(--ink-4)" strokeWidth={1.6} strokeDasharray="4 4" />)}
          </svg>
          {STEPS.map((s) => <Node key={s.id} s={s} onFile={onFile} />)}
          {/* The change, where it happened: under the step it dropped, saying why in a line. */}
          <div className="absolute flex items-start gap-1.5 text-[11.5px]/[15px] text-warning" style={{ left: x(dropped.col) + 4, top: y(dropped.row) + H + 5, width: W + GX + W - 20 }}>
            <Icon name="branch" size={12} className="mt-px" /><span><b>Change · {CHANGE.when}</b> <span className="text-ink-3">{CHANGE.why}</span></span>
          </div>
          {/* Where the path ends: the destination, with how far it is met. */}
          <div className="absolute flex items-center gap-2.5 rounded-[12px] bg-card px-3 ring-1 ring-border" style={{ left: x(END_COL), top: y(1), width: W, height: H }}>
            <span className="flex size-[30px] flex-none items-center justify-center rounded-full bg-foreground text-background"><Icon name="principles" size={15} /></span>
            <span className="flex min-w-0 flex-col">
              <span className="text-[10.5px]/[14px] font-bold tracking-wide text-ink-3 uppercase">Destination</span>
              <span className="flex items-center gap-1.5 text-[12.5px]/[16px]"><span className="flex gap-1">{OUTCOMES.map(([text, ok]) => <span key={text} className={cn('size-[9px] rounded-[3px]', ok ? 'bg-success' : 'ring-[1.5px] ring-ink-4 ring-inset')} />)}</span>{met} / {OUTCOMES.length} met</span>
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
