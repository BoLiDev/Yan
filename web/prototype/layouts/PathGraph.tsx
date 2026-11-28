/*
 * PROTOTYPE. The path drawn as a graph, in a drawer that slides over the
 * page from its left edge: a node for each step, shaped by its kind, a line
 * from each step to the steps that rely on it, and the destination at the
 * foot. Dependency runs top down.
 *
 * Under it, the path's history as a line of moments: each time steps were
 * added, a step was finished, or a change re-routed the path. Picking a
 * moment draws the path as it was then, with what happened at that moment
 * ringed; a change is a moment of its own kind, and what it says is read
 * there, not on the graph. A first take: how a path is drawn is its own ticket.
 */
import { useState } from 'react';
import { FileText, FlaskConical, Hammer, Search, Signpost, type LucideIcon } from 'lucide-react';
import { Icon } from '@/components/Icon';
import { SHIMMER, Tool } from '@/components/page';
import { cn } from '@/lib/utils';
import { HISTORY, LAST, MET_FROM, ONCE, OUTCOMES_AT_FIRST, STEPS, type MockStep, type StepKind, type StepState } from './data';

const W = 172, H = 60, GX = 18, GY = 30, PAD = 20;
/** Top down: a step's level (how far along the path it is) is its row here, and its lane across is its column. */
const x = (lane: number): number => PAD + lane * (W + GX);
const y = (level: number): number => PAD + level * (H + GY);
const END = Math.max(...STEPS.map((s) => s.col)) + 1;
const WIDTH = x(2) + W + PAD;
const HEIGHT = y(END) + H + PAD;
const NOW = HISTORY.length - 1;

/** A kind's mark and the shape its tile is cut to: a decision a diamond, research a circle, a prototype a dashed square, a spec a page, a build a hexagon. */
const KINDS: Record<StepKind, { word: string; Mark: LucideIcon; shape: string }> = {
  decision: { word: 'Decision', Mark: Signpost, shape: '[clip-path:polygon(50%_0,100%_50%,50%_100%,0_50%)]' },
  research: { word: 'Research', Mark: Search, shape: 'rounded-full' },
  prototype: { word: 'Prototype', Mark: FlaskConical, shape: 'rounded-[9px]' },
  spec: { word: 'Spec', Mark: FileText, shape: '[clip-path:polygon(0_0,68%_0,100%_32%,100%_100%,0_100%)] rounded-[4px]' },
  build: { word: 'Build', Mark: Hammer, shape: '[clip-path:polygon(25%_3%,75%_3%,100%_50%,75%_97%,25%_97%,0_50%)]' },
};

const TONE: Record<StepState, { tile: string; card: string }> = {
  done: { tile: 'bg-success-soft text-success', card: 'bg-card ring-1 ring-border' },
  working: { tile: 'bg-brand text-[var(--card)]', card: 'bg-brand-wash ring-1 ring-brand' },
  ready: { tile: 'bg-hover text-ink-2', card: 'bg-card ring-1 ring-border' },
  waiting: { tile: 'bg-hover text-ink-4', card: 'outline-dashed outline-1 -outline-offset-1 outline-[var(--ink-4)]' },
  dropped: { tile: 'bg-hover text-ink-4', card: 'ring-1 ring-border opacity-55' },
};

/** The path as it was at moment `t`: which steps were on it, each one's state then, and what each relied on then. */
function pathAt(t: number): { steps: readonly (MockStep & { on: readonly string[] })[]; touched: ReadonlySet<string>; outcomes: number; met: number } {
  const added = new Set<string>(), done = new Set<string>(), dropped = new Set<string>();
  let outcomes = OUTCOMES_AT_FIRST;
  HISTORY.slice(0, t + 1).forEach((m) => {
    m.adds?.forEach((id) => added.add(id));
    m.done?.forEach((id) => done.add(id));
    m.change?.drops.forEach((id) => dropped.add(id));
    if (m.change) outcomes = m.change.outcomes;
  });
  const m = HISTORY[t];
  const touched = new Set<string>([...(m?.adds ?? []), ...(m?.done ?? []), ...(m?.change?.drops ?? [])]);
  const steps = STEPS.filter((s) => added.has(s.id)).map((s) => {
    const on = [...s.on, ...(ONCE[s.id] ?? []).filter((id) => !dropped.has(id))];
    let state: StepState = on.every((id) => done.has(id)) ? 'ready' : 'waiting';
    if (dropped.has(s.id)) state = 'dropped';
    else if (done.has(s.id)) state = 'done';
    else if (t === NOW && s.state === 'working') state = 'working';
    return { ...s, on, state };
  });
  const met = MET_FROM.reduce((n, [from, count]) => (t >= from ? count : n), 0);
  return { steps, touched, outcomes, met };
}

function Node({ s, lit, onFile, toChange }: { s: MockStep; lit: boolean; onFile: (path: string) => void; toChange?: () => void }) {
  const k = KINDS[s.kind];
  const t = TONE[s.state];
  const first = s.files[0];
  return (
    <div className="absolute" style={{ left: x(s.row), top: y(s.col), width: W, height: H }}>
      <button type="button" title={first ? 'Open what it left' : undefined} onClick={() => { if (first) onFile(first); }}
        className={cn('flex size-full cursor-pointer items-center gap-2.5 rounded-[12px] px-2.5 text-left hover:brightness-110', t.card, lit && 'shadow-[0_0_0_3px_var(--brand-soft)] ring-1 ring-brand')}>
        <span className={cn('flex size-[30px] flex-none items-center justify-center', k.shape, t.tile, s.kind === 'prototype' && 'outline-dashed outline-1 -outline-offset-2 outline-current')}><k.Mark size={14} strokeWidth={2} aria-hidden="true" /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[10.5px]/[14px] font-bold tracking-wide text-ink-3 uppercase">{k.word}</span>
          <span className={cn('line-clamp-2 text-[12.5px]/[16px]', s.state === 'working' && SHIMMER, s.state === 'dropped' && 'line-through', (s.state === 'waiting' || s.state === 'dropped') && 'text-ink-3')} title={s.title}>{s.title}</span>
        </span>
      </button>
      {/* A dropped step carries the mark of the change that dropped it; the mark goes to that change on the line below. */}
      {toChange ? <button type="button" aria-label="The change that dropped it" title="The change that dropped it" onClick={toChange} className="absolute -top-[7px] -right-[7px] flex size-[18px] cursor-pointer items-center justify-center"><span className="size-[11px] rotate-45 rounded-[2px] bg-warning ring-2 ring-background" /></button> : null}
    </div>
  );
}

/** A line from the foot of one box to the head of another, bending once between their levels. */
function edge(fromLane: number, fromLevel: number, toLane: number, toLevel: number): string {
  const x1 = x(fromLane) + W / 2, y1 = y(fromLevel) + H, x2 = x(toLane) + W / 2, y2 = y(toLevel);
  const mid = y2 - GY / 2;
  return `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
}

/** The path's history: a mark for each moment, a change's its own, the one shown ringed; under it, when that was, and for a change what it said. */
function History({ t, pick }: { t: number; pick: (t: number) => void }) {
  const [more, setMore] = useState(false);
  const m = HISTORY[t];
  return (
    <div className="flex flex-none flex-col gap-2 border-t px-4 pt-3 pb-4">
      <div className="flex items-center gap-1">
        <Tool name="prev" label="Earlier (←)" onClick={() => pick(Math.max(0, t - 1))} disabled={t === 0} small />
        <div className="relative flex h-7 min-w-0 flex-1 items-center justify-between px-1">
          <span className="absolute inset-x-2 top-1/2 h-px bg-border" />
          <span className="absolute top-1/2 left-2 h-px bg-brand" style={{ width: `calc((100% - 16px) * ${t / NOW})` }} />
          {HISTORY.map((h, i) => (
            <button key={h.when} type="button" aria-label={h.when} aria-current={i === t} title={h.when} onClick={() => pick(i)} className="relative z-[1] flex size-6 cursor-pointer items-center justify-center">
              <span className={cn('transition-transform', h.change ? 'size-[11px] rotate-45 rounded-[2px]' : 'size-[9px] rounded-full',
                h.change ? 'bg-warning' : i <= t ? 'bg-brand' : 'bg-[var(--ink-4)]', i === t && 'scale-125 ring-[3px] ring-brand-soft')} />
            </button>
          ))}
        </div>
        <Tool name="next" label="Later (→)" onClick={() => pick(Math.min(NOW, t + 1))} disabled={t === NOW} small />
      </div>
      <div className="flex min-h-[38px] items-start gap-2.5 px-2 text-[12.5px]/[19px]">
        <b className={cn('flex-none tabular-nums', m?.change && 'text-warning')}>{m?.when}</b>
        {m?.change ? (
          <button type="button" className={cn('min-w-0 flex-1 cursor-pointer text-left text-ink-2', !more && 'line-clamp-2')} title={more ? undefined : 'Read it all'} onClick={() => setMore(!more)}>{m.change.why}</button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The drawer: over the page from its left edge, the page dimmed behind it and left as it was. A click on what is
 * behind, or Esc, closes it. Always drawn, so it slides both ways.
 */
export function PathDrawer({ open, onClose, onFile }: { open: boolean; onClose: () => void; onFile: (path: string) => void }) {
  const [t, setT] = useState(NOW);
  const { steps, touched, outcomes, met } = pathAt(t);
  const at = (id: string): MockStep | undefined => steps.find((s) => s.id === id);
  const changeOf = (id: string): number => HISTORY.findIndex((m) => m.change?.drops.includes(id));
  return (
    <>
      <div className={cn('fixed inset-0 z-40 bg-shade transition-opacity duration-200', open ? 'opacity-100' : 'pointer-events-none opacity-0')} onClick={onClose} />
      <section aria-label="Path" aria-hidden={!open} style={{ width: WIDTH + 12 }}
        onKeyDown={(e) => { if (e.key === 'ArrowLeft') setT(Math.max(0, t - 1)); else if (e.key === 'ArrowRight') setT(Math.min(NOW, t + 1)); }}
        className={cn('fixed inset-y-0 left-0 z-50 flex flex-col bg-background shadow-[0_0_0_1px_var(--line),0_24px_60px_-10px_var(--shadow-strong)] transition-transform duration-[260ms] ease-[cubic-bezier(.2,.8,.2,1)]', open ? 'translate-x-0' : '-translate-x-[105%]')}>
        <div className="flex flex-none items-center gap-3 pt-4 pr-3 pb-1 pl-5">
          <b className="flex-1 text-[19px] tracking-[-0.01em]">Path</b>
          <Tool name="close" label="Close (Esc)" onClick={onClose} small />
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="relative" style={{ width: WIDTH, height: HEIGHT }}>
            <svg className="absolute inset-0" width={WIDTH} height={HEIGHT} aria-hidden="true">
              {steps.flatMap((s) => s.on.map((from) => {
                const f = at(from);
                if (!f) return null;
                const faint = s.state === 'dropped' || f.state === 'dropped';
                const walked = f.state === 'done' && (s.state === 'done' || s.state === 'working');
                return <path key={`${from}>${s.id}`} d={edge(f.row, f.col, s.row, s.col)} fill="none" stroke={walked ? 'var(--green)' : 'var(--ink-4)'} strokeWidth={1.6} strokeDasharray={walked ? undefined : '4 4'} opacity={faint ? 0.5 : 1} />;
              }))}
              {/* Whatever nothing else relies on yet leads to the destination. */}
              {steps.filter((s) => s.state !== 'dropped' && (t === NOW ? LAST.includes(s.id) : !steps.some((o) => o.on.includes(s.id)))).map((s) => <path key={s.id} d={edge(s.row, s.col, 1, END)} fill="none" stroke="var(--ink-4)" strokeWidth={1.6} strokeDasharray="4 4" opacity={0.7} />)}
            </svg>
            {steps.map((s) => <Node key={s.id} s={s} lit={t !== NOW && touched.has(s.id)} onFile={onFile} toChange={s.state === 'dropped' ? () => setT(changeOf(s.id)) : undefined} />)}
            {/* Where the path ends: the destination, a square for each outcome, filled once it is met. */}
            <div className={cn('absolute flex items-center gap-2.5 rounded-[12px] bg-card px-2.5 ring-1 ring-border', HISTORY[t]?.change && 'shadow-[0_0_0_3px_var(--amber-soft)] ring-warning')} style={{ left: x(1), top: y(END), width: W, height: H }}>
              <span className="flex size-[30px] flex-none items-center justify-center rounded-full bg-foreground text-background"><Icon name="principles" size={15} /></span>
              <span className="flex min-w-0 flex-col gap-[3px]">
                <span className="text-[10.5px]/[14px] font-bold tracking-wide text-ink-3 uppercase">Destination</span>
                <span className="flex gap-1">{Array.from({ length: outcomes }, (_, i) => <span key={i} className={cn('size-[10px] rounded-[3px]', i < met ? 'bg-success' : 'ring-[1.5px] ring-ink-4 ring-inset')} />)}</span>
              </span>
            </div>
          </div>
        </div>
        <History t={t} pick={setT} />
      </section>
    </>
  );
}
