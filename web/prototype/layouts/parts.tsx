/*
 * PROTOTYPE: what every variant shows, drawn once in the v1 page's language
 * (its rows, labels, bars, tools and tokens). The variants share these parts
 * and nothing of their layout. How a path is drawn is another ticket's: here
 * it is a plain list.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Resizable, ResizableHandle, ResizablePanel } from '@ui-sdk/react/resizable';
import { ListFilter, PanelsTopLeft, SquareTerminal } from 'lucide-react';
import { Icon, type IconName } from '@/components/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ASIDE, Bar, BarSep, BarTools, Crumb, Dot, GROW, KIND, LABEL, SHIMMER, Seg, Tool, WORKING as WORKING_TITLE, row } from '@/components/page';
import { Button } from '@/components/ui/button';
import { colourLines, langOf, langReady } from '@/lib/highlight';
import { renderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { DOC } from '@/views/doc';
import { CodeLines } from '@/views/Code';
import { DESTINATION, FILES, LINKS, OUTCOMES, STEPS, TASK, TASKS, WORKING, stepOf, type MockFile, type MockStep, type MockTask, type StepState, type TaskState } from './data';

export { Resizable, ResizablePanel };

/** The line between two panes: a hair wide, the brand's colour under the pointer and while dragged. UI SDK's handle. */
export function Handle({ label, dark }: { label: string; dark?: boolean }) {
  return (
    <ResizableHandle aria-label={label}
      className={cn('relative z-[2] w-px flex-none outline-none after:absolute after:inset-y-0 after:-left-[3px] after:w-[7px] data-[dragging]:bg-brand data-[hovering]:bg-brand focus-visible:bg-brand',
        dark ? 'bg-[var(--term-line)]' : 'bg-border')} />
  );
}

/* ---- marks ---- */

const TASK_MARKS: Record<TaskState, { colour: string; marks: ReactNode }> = {
  open: { colour: 'text-brand', marks: <><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M8 4.25a3.75 3.75 0 0 1 0 7.5z" fill="currentColor" /></> },
  uat: { colour: 'text-warning', marks: <><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><circle cx="8" cy="8" r="2.75" fill="currentColor" /></> },
  done: { colour: 'text-success', marks: <><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="m5 8.2 2 2 4-4.2" fill="none" stroke="var(--card)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></> },
  paused: { colour: 'text-ink-3', marks: <><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M6.5 5.5v5M9.5 5.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></> },
};

export function TaskMark({ state, size = 16 }: { state: TaskState; size?: number }) {
  const { colour, marks } = TASK_MARKS[state];
  return <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className={cn('shrink-0', colour)}>{marks}</svg>;
}

const STEP_MARKS: Record<StepState, { colour: string; marks: ReactNode }> = {
  done: TASK_MARKS.done,
  working: TASK_MARKS.open,
  ready: { colour: 'text-ink-3', marks: <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" /> },
  waiting: { colour: 'text-ink-4', marks: <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.6 2.3" /> },
  dropped: { colour: 'text-ink-4', marks: <><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="m4.2 11.8 7.6-7.6" stroke="currentColor" strokeWidth="1.5" /></> },
};

export function StepMark({ state, size = 15 }: { state: StepState; size?: number }) {
  const { colour, marks } = STEP_MARKS[state];
  return <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className={cn('shrink-0', colour)}>{marks}</svg>;
}

/* ---- the task list, and its rail ---- */

function TaskRow({ t }: { t: MockTask }) {
  const on = t.id === TASK.id;
  return (
    <a className={row({ on })} href="#" onClick={(e) => e.preventDefault()}>
      <TaskMark state={t.state} />
      <span className={cn(GROW, t.working && WORKING_TITLE)}>{t.title}</span>
      {t.dot ? <Dot title={t.dot} tone={t.dot} /> : null}
    </a>
  );
}

/** The task list as v1 has it: yan, Janus and settings, finding and starting, the groups, and the vault's light. */
export function TaskList({ onFold, mode, modeRow, modeFoot }: { onFold?: () => void; mode?: ReactNode; modeRow?: ReactNode; modeFoot?: ReactNode }) {
  const open = TASKS.filter((t) => t.state === 'open');
  return (
    <nav className="flex h-full w-full flex-col overflow-hidden bg-sunken" aria-label="Tasks">
      <div className="flex flex-none flex-col gap-3 px-2.5 pt-3.5 pb-2.5">
        <div className="flex items-center gap-2 py-0.5 pr-0.5 pl-2.5">
          <b className="text-[22px] tracking-tight">yan</b>
          <span className="flex-1" />
          {mode}
          <Tool name="janus" label="Janus" small />
          <Tool name="settings" label="Settings" small />
          <Tool name="panel" label="Hide the task list" onClick={onFold} small />
        </div>
        <div className="flex gap-1.5">
          <div className="flex h-[34px] min-w-0 flex-1 items-center gap-2 rounded-[10px] bg-hover pr-2 pl-2.5 text-[13.5px] text-ink-3">
            <Icon name="search" size={15} /><span className={GROW}>Find a task</span>
          </div>
          <Button variant="secondary" size="icon-lg" className="size-[34px] rounded-[10px] bg-hover text-ink-2" aria-label="New task"><Icon name="plus" size={16} /></Button>
          <Button variant="secondary" size="icon-lg" className="size-[34px] rounded-[10px] bg-hover text-ink-2" aria-label="Drafts"><Icon name="note" size={16} /></Button>
        </div>
        {modeRow}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2.5 pt-0.5 pb-5">
        <div className="flex flex-col gap-px">
          <div className={LABEL}>In review</div>
          {TASKS.filter((t) => t.state === 'uat').map((t) => <TaskRow key={t.id} t={t} />)}
        </div>
        <div className="flex flex-col gap-px">
          <div className={LABEL}>In progress</div>
          {open.map((t) => <TaskRow key={t.id} t={t} />)}
        </div>
        <div className="flex flex-col gap-px">
          <div className="flex min-h-7 items-center gap-2 pt-1 pr-2.5 pb-0.5 pl-2.5 text-[12.5px] font-bold text-ink-3"><Icon name="chev" size={12} width={2.25} /><span className={GROW}>Paused</span><span className="font-normal tabular-nums">1</span></div>
          <div className={LABEL}>Done</div>
          <div className="flex min-h-7 items-center gap-2 pt-1 pr-2.5 pb-0.5 pl-3 text-[12px] text-ink-3"><Icon name="chev" size={12} width={2.25} /><span className={GROW}>November</span><span className="tabular-nums">9</span></div>
          <div className="flex min-h-7 items-center gap-2 pt-1 pr-2.5 pb-0.5 pl-3 text-[12px] text-ink-3"><Icon name="chev" size={12} width={2.25} /><span className={GROW}>October</span><span className="tabular-nums">14</span></div>
        </div>
      </div>
      <div className="flex-none px-2.5 pt-2 pb-3">{modeFoot}</div>
    </nav>
  );
}

/** The task list folded: a square for each task that goes on, as v1's rail has them. */
export function Rail({ onUnfold, extra }: { onUnfold?: () => void; extra?: ReactNode }) {
  return (
    <nav className="flex h-full w-[52px] flex-none flex-col items-center gap-1.5 bg-sunken py-3.5" aria-label="Tasks">
      <Tool name="panel" label="Show the task list" onClick={onUnfold} small />
      {extra}
      <Tool name="search" label="Find a task (Ctrl+F)" small />
      <span className="my-1 h-px w-6 bg-border" />
      {TASKS.filter((t) => t.state === 'open' || t.state === 'uat').map((t) => (
        <span key={t.id} title={t.title} className={cn('relative flex size-9 cursor-pointer items-center justify-center rounded-[10px] text-[13px] font-bold', t.id === TASK.id ? 'bg-card ring-1 ring-border' : 'text-ink-2 hover:bg-hover')}>
          <span className={cn(t.working && SHIMMER)}>{t.title.slice(0, 1)}</span>
          {t.dot ? <span className={cn('absolute top-1 right-1 size-[7px] rounded-full', t.dot === 'blocked' ? 'bg-warning' : 'bg-success')} /> : null}
        </span>
      ))}
      <span className="flex-1" />
      <Tool name="plus" label="New task" small />
      <Tool name="note" label="Drafts" small />
      <Tool name="janus" label="Janus" small />
      <Tool name="settings" label="Settings" small />
    </nav>
  );
}

/* ---- the task: its head, destination, path, links ---- */

export function TaskHead({ more }: { more?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 px-2.5">
      <TaskMark state={TASK.state} size={18} />
      <h1 className="min-w-0 flex-1 truncate text-[19px]/[26px] font-bold tracking-[-0.01em]" title={TASK.title}>{TASK.title}</h1>
      {more}
    </div>
  );
}

export function Destination() {
  const met = OUTCOMES.filter(([, ok]) => ok).length;
  return (
    <div className="flex flex-col gap-px">
      <div className={cn(LABEL, 'flex')}><span className="flex-1">Destination</span><span className="font-normal tabular-nums">{met} / {OUTCOMES.length} met</span></div>
      <p className="px-2.5 pb-2 text-[13.5px]/[21px] text-ink-2">{DESTINATION}</p>
      {OUTCOMES.map(([text, ok]) => (
        <div key={text} className="flex items-start gap-2.5 rounded-[8px] px-2.5 py-1 text-[13.5px]/[21px] hover:bg-hover">
          <span className={cn('mt-[3px] flex size-[15px] flex-none items-center justify-center rounded-[4px]', ok ? 'bg-success text-[var(--card)]' : 'ring-[1.5px] ring-ink-4 ring-inset')}>{ok ? <Icon name="tick" size={11} width={3} /> : null}</span>
          <span className={ok ? 'text-ink-3' : ''}>{text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The destination as one row: that there is one, and how far it is met. Its words and its outcomes open under it when
 * asked for, and fold away again, so the column keeps its room for the path.
 */
export function DestinationRow() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-px">
      <button type="button" aria-expanded={open} className={cn(row({ at: 'nav' }), 'text-[13.5px]')} onClick={() => setOpen(!open)}>
        <Icon name="principles" size={15} className="text-ink-3" />
        <span className={GROW}>Destination</span>
        <span className="flex flex-none items-center gap-1">{OUTCOMES.map(([text, ok]) => <span key={text} title={text} className={cn('size-[9px] rounded-[3px]', ok ? 'bg-success' : 'ring-[1.5px] ring-ink-4 ring-inset')} />)}</span>
        <span className={cn('flex flex-none text-ink-3 transition-transform duration-100', open && 'rotate-90')}><Icon name="chev" size={12} width={2.25} /></span>
      </button>
      {open ? (
        <div className="mb-1 flex flex-col gap-px rounded-[10px] bg-card py-2 ring-1 ring-border">
          <p className="px-3 pb-1.5 text-[13.5px]/[21px] text-ink-2">{DESTINATION}</p>
          {OUTCOMES.map(([text, ok]) => (
            <div key={text} className="flex items-start gap-2.5 px-3 py-1 text-[13.5px]/[21px]">
              <span className={cn('mt-[3px] flex size-[15px] flex-none items-center justify-center rounded-[4px]', ok ? 'bg-success text-[var(--card)]' : 'ring-[1.5px] ring-ink-4 ring-inset')}>{ok ? <Icon name="tick" size={11} width={3} /> : null}</span>
              <span className={ok ? 'text-ink-3' : ''}>{text}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const KIND_WORD = { decision: 'dec', research: 'res', prototype: 'pro', spec: 'spec', build: 'bld' } as const;

/** The path as a plain list of steps. Picking one with files opens its first. */
export function Steps({ onFile, picked, change }: { onFile?: (path: string) => void; picked?: string | null; change?: boolean }) {
  return (
    <div className="flex flex-col gap-px">
      <div className={cn(LABEL, 'flex')}><span className="flex-1">Path</span><span className="font-normal tabular-nums">{STEPS.filter((s) => s.state === 'done').length} / {STEPS.filter((s) => s.state !== 'dropped').length} done</span></div>
      {STEPS.map((s) => (
        <Fragment key={s.id}>
          <StepRow s={s} onFile={onFile} on={picked === s.id} />
          {/* Where the path was re-routed: the change, once, between what came before it and what it left. */}
          {change && s.state === 'dropped' ? (
            <div className="my-1 flex items-center gap-2 px-2.5 text-[12px] text-warning" title="A pack is only handed to people already trusted with the task. Dropped 1 step.">
              <span className="h-px w-2 bg-warning/50" /><Icon name="branch" size={12} /><span className="flex-none font-bold">Change</span><span className="min-w-0 flex-1 truncate text-ink-3">12 Nov · a pack goes only to people already trusted</span>
            </div>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

function StepRow({ s, onFile, on }: { s: MockStep; onFile?: (path: string) => void; on: boolean }) {
  const first = s.files[0];
  return (
    <a className={cn(row({ on, at: 'nav' }), 'items-start py-[6px] text-[13.5px]/[20px]')} href="#" title={`${s.kind} · ${s.state}`}
      onClick={(e) => { e.preventDefault(); if (first) onFile?.(first); }}>
      <span className="mt-[2.5px] flex"><StepMark state={s.state} /></span>
      <span className={cn('min-w-0 flex-1', s.state === 'working' && SHIMMER, s.state === 'dropped' && 'text-ink-4 line-through', s.state === 'waiting' && 'text-ink-3')}>{s.title}</span>
      <span className={cn(KIND, 'mt-px h-[18px] w-[30px] leading-[18px]')}>{KIND_WORD[s.kind]}</span>
    </a>
  );
}

export function Links() {
  return (
    <div className="flex flex-col gap-px">
      <div className={LABEL}>Links</div>
      {LINKS.map(([label, where]) => (
        <a key={label} className={cn(row({ at: 'nav' }), 'text-[13.5px]')} href="#" onClick={(e) => e.preventDefault()}>
          <Icon name="link" size={15} className="text-ink-3" /><span className={GROW}>{label}</span><span className={ASIDE}>{where}</span>
        </a>
      ))}
    </div>
  );
}

/* ---- the files: what the steps left, and the code ---- */

function TreeRow({ depth, icon, name, aside, on, onClick, mark }: { depth: number; icon?: IconName; name: string; aside?: ReactNode; on?: boolean; onClick?: () => void; mark?: string }) {
  return (
    <a className={cn(row({ on: !!on, at: 'tree' }), icon && 'py-[5px]')} style={{ paddingLeft: `${(icon ? 10 : 32) + depth * 16}px` }} href="#" onClick={(e) => { e.preventDefault(); onClick?.(); }}>
      {icon ? <><span className="flex-none rotate-90 text-ink-3"><Icon name="chev" size={12} width={2.25} /></span><Icon name={icon} size={15} className="text-ink-3" /></> : <span className={KIND}>{name.split('.').pop()}</span>}
      <span className={GROW}>{name}</span>
      {mark ? <span className={cn('flex-none font-mono text-[11px] font-bold', mark === 'A' ? 'text-success' : 'text-warning')}>{mark}</span> : null}
      {aside}
    </a>
  );
}

/**
 * The page's layout, picked by two marks that stay where they are in both: in the task list's head, and at the top of
 * its rail when it is folded. Not the row of toggles (Seg), which is kept for what a column lists.
 */
export function ModeSwitch({ bench, onPick, stacked, words }: { bench: boolean; onPick: (bench: boolean) => void; stacked?: boolean; words?: boolean }) {
  const tall = words ? 'h-[34px] rounded-[9px]' : 'h-[26px] rounded-[7px]';
  const item = (on: boolean, to: boolean, word: string, keys: string, Mark: typeof SquareTerminal): ReactNode => (
    <Tooltip>
      <TooltipTrigger render={
        <button type="button" aria-pressed={on} aria-label={word} onClick={() => onPick(to)}
          className={cn('flex cursor-pointer items-center justify-center gap-1.5 text-[13px] text-ink-3 hover:text-foreground', tall, words ? 'flex-1 px-2' : 'w-[26px]', on && 'bg-card font-bold text-foreground shadow-xs ring-1 ring-border')}>
          <Mark size={15} strokeWidth={1.75} aria-hidden="true" />{words ? word : null}
        </button>} />
      <TooltipContent>{`${word} (${keys})`}</TooltipContent>
    </Tooltip>
  );
  return (
    <span className={cn('flex gap-0.5 bg-hover', stacked && 'flex-col', words ? 'w-full rounded-[12px] p-[3px]' : 'flex-none rounded-[9px] p-[2px]')} role="group" aria-label="Layout">
      {item(!bench, false, 'Agent', 'Ctrl+1', SquareTerminal)}
      {item(bench, true, 'Workbench', 'Ctrl+2', PanelsTopLeft)}
    </span>
  );
}

export type FilesView = 'materials' | 'repositories';

/** Rows that stand for the rest of a repository: there to be filtered out, not to be opened. */
const UNCHANGED: readonly string[] = ['index-page.ts', 'unpack.ts'];

/**
 * A task's files, one kind at a time: its materials under the step that made each, or its repositories as trees.
 * `changed` keeps only what changed, and the folders that hold it.
 */
export function Tree({ view, changed, file, onFile }: { view: FilesView; changed: boolean; file: string | null; onFile: (path: string) => void }) {
  if (view === 'materials') {
    const materials = FILES.filter((f) => f.root === 'materials' && (!changed || f.mark));
    if (!materials.length) return <div className="px-2.5 pt-1 text-[12px] text-ink-3">No artifact has changed.</div>;
    return (
      <div className="flex flex-col gap-px" role="tree">
        {materials.map((f) => (
          <div key={f.path} className="flex flex-col gap-px">
            <TreeRow depth={0} icon="folder" name={stepOf(f.step)?.title ?? f.step} aside={<span className={ASIDE}>1</span>} />
            <TreeRow depth={1} name={f.path} mark={f.mark} on={file === f.path} onClick={() => onFile(f.path)} />
          </div>
        ))}
      </div>
    );
  }
  const code = FILES.filter((f) => f.root === 'code');
  const repo = (name: string, open: boolean, count: number): ReactNode => (
    <div className={cn(row({ at: 'tree' }), 'py-[5px] pl-2.5')}>
      <span className={cn('flex-none text-ink-3', open && 'rotate-90')}><Icon name="chev" size={12} width={2.25} /></span>
      <Icon name="branch" size={15} className="text-ink-3" /><span className={GROW}>{name}</span>
      <span className="flex-none font-mono text-[11px] text-ink-3">yan/t152</span>
      {changed ? <span className={ASIDE}>{count}</span> : null}
    </div>
  );
  return (
    <div className="flex flex-col gap-px" role="tree">
      {repo('yan', true, code.length)}
      <div className="flex flex-col gap-px pl-3">
        <TreeRow depth={0} icon="folder" name="src / pack" aside={<span className={ASIDE}>{changed ? code.length : code.length + UNCHANGED.length}</span>} />
        {changed ? null : <TreeRow depth={1} name={UNCHANGED[0] as string} />}
        {changed ? null : <TreeRow depth={1} name={UNCHANGED[1] as string} />}
        {code.map((f) => <TreeRow key={f.path} depth={1} name={f.path.split('/').pop() as string} mark={f.mark} on={file === f.path} onClick={() => onFile(f.path)} />)}
        {changed ? null : <TreeRow depth={0} icon="folder" name="src / path" aside={<span className={ASIDE}>6</span>} />}
        {changed ? null : <TreeRow depth={0} icon="folder" name="tests" aside={<span className={ASIDE}>31</span>} />}
      </div>
      {changed ? null : repo('yan-site', false, 0)}
      {changed ? <div className="px-2.5 pt-2 text-[12px] text-ink-3">yan-site has no changes.</div> : null}
    </div>
  );
}

/** Only what changed, or everything: a mark alone, pressed while it filters; its tooltip says what it does and how many there are. */
export function ChangedToggle({ on, count, onChange }: { on: boolean; count: number; onChange: (on: boolean) => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={
        <button type="button" aria-pressed={on} aria-label="Only what changed" onClick={() => onChange(!on)}
          className={cn('flex size-[34px] flex-none cursor-pointer items-center justify-center rounded-lg text-ink-3 hover:bg-hover hover:text-foreground', on && 'bg-brand-soft text-brand-ink hover:bg-brand-soft hover:text-brand-ink')}>
          <ListFilter size={16} strokeWidth={1.9} aria-hidden="true" />
        </button>} />
      <TooltipContent>{on ? `Showing only what changed (${count})` : `Show only what changed (${count})`}</TooltipContent>
    </Tooltip>
  );
}

/** The path as one row, as the destination is: how far along it is, a mark for each step, and it opens the drawer the path is drawn in. */
export function PathRow({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const live = STEPS.filter((s) => s.state !== 'dropped');
  return (
    <button type="button" aria-expanded={open} className={cn(row({ on: open, at: 'nav' }), 'text-[13.5px]')} onClick={onToggle} title="Blueprint (Ctrl+P)">
      <Icon name="branch" size={15} className="text-ink-3" />
      <span className={GROW}>Blueprint</span>
      <span className="flex flex-none items-center gap-1">{live.map((s) => <span key={s.id} title={s.title} className={cn('size-[9px] rounded-full', s.state === 'done' ? 'bg-success' : s.state === 'working' ? 'bg-brand' : 'ring-[1.5px] ring-ink-4 ring-inset')} />)}</span>
      <span className={cn('flex flex-none text-ink-3 transition-transform duration-100', open && 'rotate-180')}><Icon name="chev" size={12} width={2.25} /></span>
    </button>
  );
}

/** What is being worked now and what could be taken next: the part of the path looked at all the time. */
export function Now({ onFile }: { onFile?: (path: string) => void }) {
  const next = STEPS.filter((s) => s.state === 'ready');
  return (
    <div className="flex flex-col gap-px">
      <div className={LABEL}>Now</div>
      <StepRow s={WORKING} onFile={onFile} on={false} />
      {next.length ? <div className={cn(LABEL, 'pt-3')}>Ready next</div> : null}
      {next.map((s) => <StepRow key={s.id} s={s} onFile={onFile} on={false} />)}
    </div>
  );
}

export const changedCount = (view: FilesView): number => FILES.filter((f) => (view === 'materials' ? f.root === 'materials' : f.root === 'code') && f.mark).length;

/* ---- a file, shown as what it is ---- */

function Code({ f }: { f: MockFile }) {
  const lang = langOf(f.path);
  const [, setReady] = useState(0);
  useEffect(() => {
    let live = true;
    void langReady(lang).then(() => { if (live) setReady((n) => n + 1); });
    return () => { live = false; };
  }, [lang]);
  const lines = f.text.replace(/\n$/, '').split('\n');
  return <div className="px-6 py-5"><CodeLines lines={lines} wrap={false} coloured={colourLines(lang, f.text.replace(/\n$/, ''))} /></div>;
}

function Doc({ f }: { f: MockFile }) {
  const html = useMemo(() => renderMarkdown(f.text).html, [f.text]);
  return <div className="mx-auto max-w-[820px] px-10 pt-8 pb-24"><div className={DOC} dangerouslySetInnerHTML={{ __html: html }} /></div>;
}

/** A file under its bar: a document rendered, code in lines, with the tools v1 gives each. `tools` come first, the pane's own. */
export function FileView({ f, onClose, lead }: { f: MockFile; onClose?: () => void; lead?: ReactNode }) {
  const md = f.path.endsWith('.md');
  const [mode, setMode] = useState<'rendered' | 'source' | 'history'>('rendered');
  const [diff, setDiff] = useState(false);
  const step = stepOf(f.step);
  return (
    <div className="flex h-full min-w-0 flex-col bg-card">
      <Bar title={<Crumb path={f.path} />}
        meta={md ? `${step?.kind} · ${step?.title} · frozen` : `yan/t152 · changed by “${step?.title}”`}
        tools={<>
          {lead}
          {md ? <Seg options={[['rendered', 'Rendered'], ['source', 'Source'], ['history', 'History']] as const} current={mode} onPick={setMode} />
            : <Seg options={[['file', 'File'], ['diff', 'Diff']] as const} current={diff ? 'diff' : 'file'} onPick={(v) => setDiff(v === 'diff')} />}
          <BarSep />
          <BarTools>
            <Tool name="note" label="Comment on a selection" />
            <Tool name="copy" label="Copy the path" />
            {onClose ? <Tool name="close" label="Close the file" onClick={onClose} /> : null}
          </BarTools>
        </>} />
      <div className="min-h-0 flex-1 overflow-auto">{md ? <Doc f={f} /> : <Code f={f} />}</div>
    </div>
  );
}

/* ---- the agent: the real CLI's terminal, stood in for ---- */

const T = {
  dim: 'text-[#8f8e85]', teal: 'text-[#5cc8db]', green: 'text-[#8fd1a6]', red: 'text-[#f07a6a]', amber: 'text-[#e3a54a]', white: 'text-white',
} as const;

/**
 * The terminal the page hosts, with Claude Code in it: dark whatever the page
 * is. `head` is what the variant puts over it; without one it is the bare
 * terminal. `column` keeps its lines to a readable width in the middle of a
 * wide pane.
 */
export function Agent({ head, column }: { head?: ReactNode; column?: boolean }) {
  return (
    <section className="flex h-full min-w-0 flex-col bg-[var(--term-bg)] text-[var(--term-fg)]" aria-label="Agent">
      {head}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className={cn('flex h-full flex-col justify-end px-4 pb-3 font-mono text-[12.5px]/[20px] whitespace-pre-wrap', column && 'mx-auto max-w-[920px]')}>
          <p className={T.dim}>{'> the materials of each step should sit beside its result, not in one flat folder'}</p>
          <p>&nbsp;</p>
          <p><span className={T.white}>●</span> Each done step gets a folder named for it, holding its result and what it left. Dropped steps are listed and their materials left out, as the spec says.</p>
          <p>&nbsp;</p>
          <p><span className={T.green}>●</span> <b>Read</b>(src/pack/write.ts)</p>
          <p className={T.dim}>  ⎿  Read 84 lines</p>
          <p>&nbsp;</p>
          <p><span className={T.green}>●</span> <b>Update</b>(src/pack/write.ts)</p>
          <p className={T.dim}>  ⎿  Added 5 lines, removed 1</p>
          <p><span className={T.dim}>     22 </span><span className={T.red}>-    entries.push(...step.materials.map((m) =&gt; m.name));</span></p>
          <p><span className={T.dim}>     22 </span><span className={T.green}>+    entries.push(`${'{'}step.id{'}'}/result.md`);</span></p>
          <p><span className={T.dim}>     23 </span><span className={T.green}>+    for (const material of step.materials) {'{'}</span></p>
          <p><span className={T.dim}>     24 </span><span className={T.green}>+      entries.push(`${'{'}step.id{'}'}/${'{'}material.name{'}'}`);</span></p>
          <p><span className={T.dim}>     25 </span><span className={T.green}>+    {'}'}</span></p>
          <p>&nbsp;</p>
          <p><span className={T.green}>●</span> <b>Bash</b>(npm test -- pack)</p>
          <p className={T.dim}>  ⎿  ✓ src/pack/write.test.ts (2 tests) 41ms</p>
          <p>&nbsp;</p>
          <p className={T.amber}>✻ Writing the step's result… <span className={T.dim}>(38s · esc to interrupt)</span></p>
          <p>&nbsp;</p>
          <div className="rounded-[6px] border border-[#5a5a54] px-3 py-1.5"><span className={T.dim}>&gt; </span><span className="inline-block h-[15px] w-[7px] translate-y-[2px] bg-[var(--term-fg)]" /></div>
          <p className={T.dim}>  <span className={T.teal}>⏵⏵ accept edits on</span> · yan/t152 · step v1sz</p>
        </div>
      </div>
    </section>
  );
}

/** What stands over a terminal: which step the session is on, and the terminal's own tools, in the terminal's colours. */
export function AgentHead({ lead, tools }: { lead?: ReactNode; tools?: ReactNode }) {
  return (
    <div className="flex min-h-11 flex-none items-center gap-2.5 border-b border-[var(--term-line)] py-1.5 pr-2 pl-4 text-[13px]">
      {lead}
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="size-[7px] flex-none animate-pulse rounded-full bg-[#5cc8db]" />
        <span className="truncate"><span className="text-[#8f8e85]">Working </span>{WORKING.title}</span>
      </span>
      <span className="flex flex-none items-center gap-0.5 text-[#a09f96] [&_button]:text-[#a09f96] [&_button:hover]:bg-white/10 [&_button:hover]:text-white">{tools}</span>
    </div>
  );
}
