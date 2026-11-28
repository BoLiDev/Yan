/*
 * PROTOTYPE. The path drawn as a graph, in a drawer that slides over the
 * page from its left edge: a node for each step, shaped by its kind, a line
 * from each step to the steps that rely on it, and the destination at the
 * foot. Dependency runs top down.
 *
 * The path has versions: each time steps were added, a step was finished,
 * or a change re-routed it. The head's menu picks one and the foot steps to
 * the one before or after; the path is drawn as it was then. Picking a step, a change or the
 * destination opens a second drawer joined to the first, where it is told
 * at length. A first take: how a path is drawn is its own ticket.
 */
import { useState, type ReactNode } from 'react';
import { FileText, FlaskConical, Hammer, Search, Signpost, type LucideIcon } from 'lucide-react';
import { Icon } from '@/components/Icon';
import { ASIDE, GROW, KIND, LABEL, SHIMMER, Tool, row } from '@/components/page';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ABOUT, DESTINATION, HISTORY, LAST, MET_FROM, ONCE, OUTCOMES, OUTCOMES_AT_FIRST, STEPS, type MockStep, type StepKind, type StepState } from './data';

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
function pathAt(t: number): { steps: readonly (MockStep & { on: readonly string[] })[]; outcomes: number; met: number } {
  const added = new Set<string>(), done = new Set<string>(), dropped = new Set<string>();
  let outcomes = OUTCOMES_AT_FIRST;
  HISTORY.slice(0, t + 1).forEach((m) => {
    m.adds?.forEach((id) => added.add(id));
    m.done?.forEach((id) => done.add(id));
    m.change?.drops.forEach((id) => dropped.add(id));
    if (m.change) outcomes = m.change.outcomes;
  });
  const steps = STEPS.filter((s) => added.has(s.id)).map((s) => {
    const on = [...s.on, ...(ONCE[s.id] ?? []).filter((id) => !dropped.has(id))];
    let state: StepState = on.every((id) => done.has(id)) ? 'ready' : 'waiting';
    if (dropped.has(s.id)) state = 'dropped';
    else if (done.has(s.id)) state = 'done';
    else if (t === NOW && s.state === 'working') state = 'working';
    return { ...s, on, state };
  });
  const met = MET_FROM.reduce((n, [from, count]) => (t >= from ? count : n), 0);
  return { steps, outcomes, met };
}

function Node({ s, on, pick, toChange }: { s: MockStep; on: boolean; pick: () => void; toChange?: () => void }) {
  const k = KINDS[s.kind];
  const t = TONE[s.state];
  return (
    <div className="absolute" style={{ left: x(s.row), top: y(s.col), width: W, height: H }}>
      <button type="button" aria-pressed={on} onClick={pick}
        className={cn('flex size-full cursor-pointer items-center gap-2.5 rounded-[12px] px-2.5 text-left hover:brightness-110', t.card, on && 'opacity-100 ring-2 ring-foreground')}>
        <span className={cn('flex size-[30px] flex-none items-center justify-center', k.shape, t.tile, s.kind === 'prototype' && 'outline-dashed outline-1 -outline-offset-2 outline-current')}><k.Mark size={14} strokeWidth={2} aria-hidden="true" /></span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-[10.5px]/[14px] font-bold tracking-wide text-ink-3 uppercase">{k.word}</span>
          <span className={cn('line-clamp-2 text-[12.5px]/[16px]', s.state === 'working' && SHIMMER, (s.state === 'waiting' || s.state === 'dropped') && 'text-ink-3')} title={s.title}>{s.title}</span>
        </span>
      </button>
      {/* A dropped step carries the mark of the change that dropped it; the mark opens that change. */}
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

/** What is picked in the graph, shown in the second drawer: a step, a change (by its moment), or the destination. */
type Picked = { step: string } | { change: number } | 'destination' | null;

const STATE_WORD: Record<StepState, string> = { done: 'Done', working: 'In work', ready: 'Ready', waiting: 'Waiting', dropped: 'Dropped' };

function Part({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-col"><div className={cn(LABEL, 'px-0')}>{label}</div><div className="text-[13.5px]/[21px] text-ink-2">{children}</div></div>;
}

function StepLine({ s, pick }: { s: MockStep; pick: () => void }) {
  const k = KINDS[s.kind];
  return (
    <button type="button" className={cn(row({ at: 'nav' }), '-mx-2.5 w-[calc(100%+20px)] text-[13.5px]')} onClick={pick}>
      <span className={cn('flex size-[18px] flex-none items-center justify-center bg-hover text-ink-2', k.shape, s.kind === 'prototype' && 'rounded-[5px]')}><k.Mark size={10} strokeWidth={2.2} aria-hidden="true" /></span>
      <span className={cn(GROW, s.state === 'dropped' && 'text-ink-3')}>{s.title}</span>
    </button>
  );
}

/** The second drawer: joined to the first at its right edge, a line between them, and as tall. What is picked, at length; it scrolls on its own. */
function Details({ picked: now, last, shown, steps, outcomes, met, left, pick, onClose, onFile }: {
  picked: Picked; last: Picked; shown: boolean; steps: readonly MockStep[]; outcomes: number; met: number; left: number;
  pick: (p: Picked) => void; onClose: () => void; onFile: (path: string) => void;
}) {
  // What it showed last stays in it while it slides away.
  const picked = now ?? last;
  const step = picked && typeof picked === 'object' && 'step' in picked ? steps.find((s) => s.id === picked.step) : undefined;
  const change = picked && typeof picked === 'object' && 'change' in picked ? HISTORY[picked.change] : undefined;
  const open = shown && now !== null && (picked === 'destination' || !!step || !!change);
  let head: ReactNode = null;
  let body: ReactNode = null;
  if (step) {
    const k = KINDS[step.kind];
    const about = ABOUT[step.id];
    const dropAt = HISTORY.findIndex((m) => m.change?.drops.includes(step.id));
    head = <><span className="text-[10.5px]/[14px] font-bold tracking-wide text-ink-3 uppercase">{k.word} <span className={cn('ml-1.5', step.state === 'working' ? 'text-brand' : step.state === 'done' ? 'text-success' : '')}>{STATE_WORD[step.state]}</span></span><b className="text-[17px]/[23px] tracking-[-0.01em]">{step.title}</b></>;
    body = (
      <>
        <Part label="What it is about">{about?.about}</Part>
        {step.state === 'done' && about?.result ? <Part label="Result">{about.result}</Part> : null}
        {step.state === 'dropped' && dropAt >= 0 ? (
          <Part label="Why it was dropped">
            <span className="line-clamp-4">{HISTORY[dropAt]?.change?.why}</span>
            <button type="button" className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-warning hover:underline" onClick={() => pick({ change: dropAt })}><span className="size-[9px] rotate-45 rounded-[2px] bg-warning" />The change of {HISTORY[dropAt]?.when}</button>
          </Part>
        ) : null}
        {step.files.length ? (
          <Part label="What it left">
            {step.files.map((f) => (
              <button key={f} type="button" className={cn(row({ at: 'tree' }), '-mx-2.5 w-[calc(100%+20px)]')} onClick={() => onFile(f)}><span className={KIND}>{f.split('.').pop()}</span><span className={GROW}>{f}</span></button>
            ))}
          </Part>
        ) : null}
        {about?.sessions ? <Part label="Sessions">{Array.from({ length: about.sessions }, (_, i) => <div key={i} className={cn(row({ at: 'nav' }), '-mx-2.5 w-[calc(100%+20px)] text-[13.5px]')}><Icon name="terminal" size={15} className="text-ink-3" /><span className={GROW}>Session {i + 1}</span><span className={ASIDE}>{step.state === 'working' && i === about.sessions - 1 ? 'live' : 'resume'}</span></div>)}</Part> : null}
      </>
    );
  } else if (change?.change) {
    head = <><span className="flex items-center gap-1.5 text-[10.5px]/[14px] font-bold tracking-wide text-warning uppercase"><span className="size-[9px] rotate-45 rounded-[2px] bg-warning" />Change</span><b className="text-[17px]/[23px] tracking-[-0.01em]">{change.when}</b></>;
    body = (
      <>
        <Part label="What changed">{change.change.why}</Part>
        <Part label="Dropped">{change.change.drops.map((id) => { const s = STEPS.find((o) => o.id === id); return s ? <StepLine key={id} s={{ ...s, state: 'dropped' }} pick={() => pick({ step: id })} /> : null; })}</Part>
        <Part label="Destination">{OUTCOMES_AT_FIRST} outcomes became {change.change.outcomes}: “The archive cannot be read without its password” was taken off.</Part>
      </>
    );
  } else if (picked === 'destination') {
    head = <><span className="text-[10.5px]/[14px] font-bold tracking-wide text-ink-3 uppercase">Destination</span></>;
    body = (
      <>
        <p className="text-[14.5px]/[23px]">{DESTINATION}</p>
        <Part label="Outcomes">
          {OUTCOMES.slice(0, outcomes).map(([text], i) => (
            <div key={text} className="flex items-start gap-2.5 py-1">
              <span className={cn('mt-[3px] flex size-[15px] flex-none items-center justify-center rounded-[4px]', i < met ? 'bg-success text-[var(--card)]' : 'ring-[1.5px] ring-ink-4 ring-inset')}>{i < met ? <Icon name="tick" size={11} width={3} /> : null}</span>
              <span className={i < met ? 'text-ink-3' : 'text-foreground'}>{text}</span>
            </div>
          ))}
          {outcomes > OUTCOMES.length ? <div className="flex items-start gap-2.5 py-1"><span className="mt-[3px] size-[15px] flex-none rounded-[4px] ring-[1.5px] ring-ink-4 ring-inset" /><span className="text-foreground">The archive cannot be read without its password</span></div> : null}
        </Part>
      </>
    );
  }
  return (
    // Out of sight it is behind the first drawer when that is open, and off the page's left edge with it when it is not: the two slide as one.
    <section aria-label="Details" aria-hidden={!open} style={{ left, width: 380, transform: open ? 'none' : shown ? 'translateX(-100%)' : `translateX(${-(left + 400)}px)` }}
      className="fixed inset-y-0 z-[45] flex flex-col border-l bg-background shadow-[0_24px_60px_-10px_var(--shadow-strong)] transition-transform duration-[260ms] ease-[cubic-bezier(.2,.8,.2,1)]">
      <div className="flex flex-none items-start gap-3 pt-[18px] pr-3 pb-3 pl-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1">{head}</div>
        <Tool name="close" label="Close the details" onClick={onClose} small />
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 pb-10">{body}</div>
    </section>
  );
}

/**
 * The drawer: over the page from its left edge, the page dimmed behind it and left as it was. A click on what is
 * behind, or Esc, closes it. Always drawn, so it slides both ways. Its head picks which version of the path is drawn,
 * its foot steps to the one before and after, and neither changes size: what is said at length is in the second drawer.
 */
export function PathDrawer({ open, onClose, onFile }: { open: boolean; onClose: () => void; onFile: (path: string) => void }) {
  const [t, setT] = useState(NOW);
  const [picked, pickNow] = useState<Picked>(null);
  const [last, setLast] = useState<Picked>(null);
  const setPicked = (p: Picked): void => {
    if (p !== null) setLast(p);
    pickNow(p);
  };
  const { steps, outcomes, met } = pathAt(t);
  const at = (id: string): MockStep | undefined => steps.find((s) => s.id === id);
  const changeOf = (id: string): number => HISTORY.findIndex((m) => m.change?.drops.includes(id));
  const go = (to: number): void => {
    const next = Math.max(0, Math.min(NOW, to));
    setT(next);
    // Arriving at a change shows it; leaving one puts it away.
    if (HISTORY[next]?.change) setPicked({ change: next });
    else if (picked && typeof picked === 'object' && 'change' in picked) setPicked(null);
  };
  const isChange = (i: number): boolean => !!picked && typeof picked === 'object' && 'change' in picked && picked.change === i;
  const isStep = (id: string): boolean => !!picked && typeof picked === 'object' && 'step' in picked && picked.step === id;
  const m = HISTORY[t];
  const width = WIDTH + 12;
  return (
    <>
      <div className={cn('fixed inset-0 z-40 bg-shade transition-opacity duration-200', open ? 'opacity-100' : 'pointer-events-none opacity-0')} onClick={onClose} />
      <Details picked={picked} last={last} shown={open} steps={steps} outcomes={outcomes} met={met} left={width} pick={setPicked} onClose={() => setPicked(null)} onFile={onFile} />
      <section aria-label="Path" aria-hidden={!open} style={{ width }}
        onKeyDown={(e) => { if (e.key === 'ArrowLeft') go(t - 1); else if (e.key === 'ArrowRight') go(t + 1); }}
        className={cn('fixed inset-y-0 left-0 z-50 flex flex-col bg-background shadow-[0_0_0_1px_var(--line)] transition-transform duration-[260ms] ease-[cubic-bezier(.2,.8,.2,1)]', open ? 'translate-x-0' : '-translate-x-[105%]')}>
        <div className="flex h-[58px] flex-none items-center gap-3 pr-3 pl-5">
          <b className="text-[19px] tracking-[-0.01em]">Path</b>
          <DropdownMenu>
            <DropdownMenuTrigger render={
              <button type="button" className="flex h-[30px] cursor-pointer items-center gap-2 rounded-lg bg-hover pr-2 pl-2.5 text-[13px] hover:bg-foreground/10" title="Which version of the path is drawn">
                {m?.change ? <span className="size-[9px] rotate-45 rounded-[2px] bg-warning" /> : null}<span className="tabular-nums">{m?.when}</span><Icon name="unfold" size={13} className="text-ink-3" />
              </button>} />
            <DropdownMenuContent align="start" className="w-[280px]">
              {HISTORY.map((_, i) => HISTORY.length - 1 - i).map((i) => {
                const h = HISTORY[i] as (typeof HISTORY)[number];
                return (
                  <DropdownMenuItem key={h.when} onClick={() => go(i)} className={cn('gap-2.5', i === t && 'bg-accent font-bold')}>
                    <span className="w-[52px] flex-none tabular-nums">{h.when}</span>
                    <span className={cn('flex min-w-0 flex-1 items-center gap-1.5 truncate font-normal', h.change ? 'text-warning' : 'text-ink-3')}>{h.change ? <span className="size-[8px] flex-none rotate-45 rounded-[2px] bg-warning" /> : null}{h.what}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="flex-1" />
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
            {steps.map((s) => <Node key={s.id} s={s} on={isStep(s.id)} pick={() => setPicked(isStep(s.id) ? null : { step: s.id })} toChange={s.state === 'dropped' ? () => setPicked(isChange(changeOf(s.id)) ? null : { change: changeOf(s.id) }) : undefined} />)}
            {/* Where the path ends: the destination, a square for each outcome, filled once it is met. */}
            <button type="button" onClick={() => setPicked(picked === 'destination' ? null : 'destination')} className={cn('absolute flex cursor-pointer items-center gap-2.5 rounded-[12px] bg-card px-2.5 text-left ring-1 ring-border hover:brightness-110', picked === 'destination' && 'ring-2 ring-foreground')} style={{ left: x(1), top: y(END), width: W, height: H }}>
              <span className="flex size-[30px] flex-none items-center justify-center rounded-full bg-foreground text-background"><Icon name="principles" size={15} /></span>
              <span className="flex min-w-0 flex-col gap-[3px]">
                <span className="text-[10.5px]/[14px] font-bold tracking-wide text-ink-3 uppercase">Destination</span>
                <span className="flex gap-1">{Array.from({ length: outcomes }, (_, i) => <span key={i} className={cn('size-[10px] rounded-[3px]', i < met ? 'bg-success' : 'ring-[1.5px] ring-ink-4 ring-inset')} />)}</span>
              </span>
            </button>
          </div>
        </div>
        <div className="flex h-[52px] flex-none items-center justify-between border-t px-3">
          <button type="button" disabled={t === 0} onClick={() => go(t - 1)} className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg pr-3 pl-2 text-[13px] text-ink-2 hover:bg-hover hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent"><Icon name="prev" size={15} />Previous</button>
          <button type="button" disabled={t === NOW} onClick={() => go(t + 1)} className="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg pr-2 pl-3 text-[13px] text-ink-2 hover:bg-hover hover:text-foreground disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent">Next<Icon name="next" size={15} /></button>
        </div>
      </section>
    </>
  );
}
