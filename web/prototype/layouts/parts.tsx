/*
 * PROTOTYPE: what every variant shows, drawn once in the v1 page's language
 * (its rows, labels, bars, tools and tokens). The variants share these parts
 * and nothing of their layout. How a path is drawn is another ticket's: here
 * it is a plain list.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Resizable, ResizableHandle, ResizablePanel } from '@ui-sdk/react/resizable';
import { BookMarked, CircleCheck, CirclePause, ListFilter, PanelsTopLeft, SquareTerminal } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon, type IconName } from '@/components/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ASIDE, BarSep, BarTools, Dot, GROW, KIND, LABEL, SHIMMER, Seg, Tool, WORKING as WORKING_TITLE, row } from '@/components/page';
import { Button } from '@/components/ui/button';
import { colourLines, langOf, langReady } from '@/lib/highlight';
import { renderMarkdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import { DOC } from '@/views/doc';
import { DESTINATION, FILES, LINKS, OUTCOMES, STEPS, TASK, TASKS, WORKING, stepOf, type MockFile, type MockStep, type MockTask, type StepState, type TaskState } from './data';

export { Resizable, ResizablePanel };

/** The line between two panes: a hair wide, the brand's colour under the pointer and while dragged. UI SDK's handle. */
export function Handle({ label }: { label: string; dark?: boolean }) {
  return (
    <ResizableHandle aria-label={label}
      className={cn('relative z-[2] w-px flex-none outline-none after:absolute after:inset-y-0 after:-left-[3px] after:w-[7px] data-[dragging]:bg-brand data-[hovering]:bg-brand focus-visible:bg-brand', 'bg-border')} />
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

/** A task that is not being worked, in a menu: where it stood, and its title. */
const SHELVED = {
  paused: [['t140', 'Serve starts in under a second']],
  November: [['t146', 'The palette finds by pinyin'], ['t144', 'A review keeps its place after a push'], ['t141', 'Peek reads git once']],
  October: [['t133', 'A local vault only commits'], ['t128', 'Drafts are no task\'s']],
} as const;

/**
 * The tasks put aside and the tasks closed, each behind a mark: looked at rarely, so they take no room in the list.
 * A mark opens a menu of them, the closed ones by month.
 */
function Shelved() {
  const mark = 'flex size-[30px] cursor-pointer items-center justify-center rounded-lg text-ink-3 hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground';
  return (
    <div className="flex items-center gap-0.5 px-0.5">
      <DropdownMenu>
        <DropdownMenuTrigger render={<button type="button" className={mark} aria-label="Paused tasks" title="Paused tasks"><CirclePause size={16} strokeWidth={1.75} aria-hidden="true" /></button>} />
        <DropdownMenuContent side="top" align="start" className="w-[280px]">
          {SHELVED.paused.map(([id, title]) => <DropdownMenuItem key={id} className="gap-2.5"><TaskMark state="paused" /><span className="truncate">{title}</span></DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownMenuTrigger render={<button type="button" className={mark} aria-label="Done tasks" title="Done tasks"><CircleCheck size={16} strokeWidth={1.75} aria-hidden="true" /></button>} />
        <DropdownMenuContent side="top" align="start" className="max-h-[420px] w-[300px]">
          {(['November', 'October'] as const).map((month) => (
            <DropdownMenuGroup key={month}>
              <DropdownMenuLabel>{month}</DropdownMenuLabel>
              {SHELVED[month].map(([id, title]) => <DropdownMenuItem key={id} className="gap-2.5"><TaskMark state="done" /><span className="truncate">{title}</span></DropdownMenuItem>)}
            </DropdownMenuGroup>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
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
        {/* One list: a task's mark says where it stands, and the ones waiting on the user come first. */}
        <div className="flex flex-col gap-px">
          {TASKS.filter((t) => t.state === 'uat').map((t) => <TaskRow key={t.id} t={t} />)}
          {open.map((t) => <TaskRow key={t.id} t={t} />)}
        </div>
      </div>
      <div className="flex flex-none flex-col gap-2 px-2.5 pt-2 pb-3"><Shelved />{modeFoot}</div>
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
    <a className={cn(row({ on, at: 'nav' }), 'items-start py-[6px] text-[13.5px]/[20px]')} href="#"
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

function TreeRow({ depth, icon, name, aside, on, onClick, onKeep, mark, shut }: { depth: number; icon?: IconName; name: string; aside?: ReactNode; on?: boolean; onClick?: () => void; onKeep?: () => void; mark?: string; shut?: boolean }) {
  return (
    <a className={cn(row({ on: !!on, at: 'tree' }), icon && 'py-[5px]')} style={{ paddingLeft: `${(icon ? 10 : 32) + depth * 16}px` }} href="#" onClick={(e) => { e.preventDefault(); onClick?.(); }} onDoubleClick={onKeep}>
      {icon ? <><span className={cn('flex-none text-ink-3', !shut && 'rotate-90')}><Icon name="chev" size={12} width={2.25} /></span><Icon name={icon} size={15} className="text-ink-3" /></> : <span className={KIND}>{name.split('.').pop()}</span>}
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
export function Tree({ view, changed, file, onFile, onKeep }: { view: FilesView; changed: boolean; file: string | null; onFile: (path: string) => void; onKeep?: (path: string) => void }) {
  if (view === 'materials') {
    const materials = FILES.filter((f) => f.root === 'materials' && (!changed || f.mark));
    if (!materials.length) return <div className="px-2.5 pt-1 text-[12px] text-ink-3">No artifact has changed.</div>;
    return (
      <div className="flex flex-col gap-px" role="tree">
        {materials.map((f) => (
          <div key={f.path} className="flex flex-col gap-px">
            <TreeRow depth={0} icon="folder" name={stepOf(f.step)?.title ?? f.step} />
            <TreeRow depth={1} name={f.path} mark={f.mark} on={file === f.path} onClick={() => onFile(f.path)} onKeep={() => onKeep?.(f.path)} />
          </div>
        ))}
      </div>
    );
  }
  const code = FILES.filter((f) => f.root === 'code');
  const companion = FILES.filter((f) => f.root === 'companion' && (!changed || f.mark));
  const repo = (name: string, open: boolean): ReactNode => (
    <div className={cn(row({ at: 'tree' }), 'py-[5px] pl-2.5')}>
      <span className={cn('flex-none text-ink-3', open && 'rotate-90')}><Icon name="chev" size={12} width={2.25} /></span>
      <Icon name="branch" size={15} className="text-ink-3" /><span className={GROW}>{name}</span>
      <span className="flex-none font-mono text-[11px] text-ink-3">yan/t152</span>
    </div>
  );
  return (
    <div className="flex flex-col gap-px" role="tree">
      {repo('yan', true)}
      <div className="flex flex-col gap-px pl-3">
        {/* The repository's companion, first under it and marked as its own kind of folder: what outlives any task here and is not committed to the repository. */}
        {companion.length ? (
          <div className={cn(row({ at: 'tree' }), 'py-[5px] pl-2.5')}>
            <span className="flex-none rotate-90 text-ink-3"><Icon name="chev" size={12} width={2.25} /></span>
            <BookMarked size={15} strokeWidth={1.75} className="flex-none text-brand" aria-hidden="true" /><span className={GROW}>Companion</span>
          </div>
        ) : null}
        {companion.map((f) => <TreeRow key={f.path} depth={1} name={f.path.replace('companion/', '').replace('adr/', 'adr / ')} mark={f.mark} on={file === f.path} onClick={() => onFile(f.path)} onKeep={() => onKeep?.(f.path)} />)}
        <TreeRow depth={0} icon="folder" name="src / pack" />
        {changed ? null : <TreeRow depth={1} name={UNCHANGED[0] as string} />}
        {changed ? null : <TreeRow depth={1} name={UNCHANGED[1] as string} />}
        {code.map((f) => <TreeRow key={f.path} depth={1} name={f.path.split('/').pop() as string} mark={f.mark} on={file === f.path} onClick={() => onFile(f.path)} onKeep={() => onKeep?.(f.path)} />)}
        {changed ? null : <TreeRow depth={0} icon="folder" name="src / path" shut aside={<span className={ASIDE}>6</span>} />}
        {changed ? null : <TreeRow depth={0} icon="folder" name="tests" shut aside={<span className={ASIDE}>31</span>} />}
      </div>
      {changed ? null : repo('yan-site', false)}
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

export const changedCount = (view: FilesView): number => FILES.filter((f) => (view === 'materials' ? f.root === 'materials' : f.root !== 'materials') && f.mark).length;

/* ---- a file, shown as what it is ---- */

function Code({ f }: { f: MockFile }) {
  const lang = langOf(f.path);
  const [, setReady] = useState(0);
  useEffect(() => {
    let live = true;
    void langReady(lang).then(() => { if (live) setReady((n) => n + 1); });
    return () => { live = false; };
  }, [lang]);
  const text = f.text.replace(/\n$/, '');
  const lines = text.split('\n');
  const coloured = colourLines(lang, text);
  // The file on the pane itself, as an editor has it: its numbers, then its lines, to the pane's edges.
  return (
    <div className="min-w-max py-3 font-mono text-[12.5px]/[21px] text-ink">
      {lines.map((line, i) => (
        <div key={i} className="flex hover:bg-hover">
          <span className="w-14 flex-none pr-4 text-right text-ink-4 select-none">{i + 1}</span>
          {coloured ? <span className="pr-8 whitespace-pre" dangerouslySetInnerHTML={{ __html: coloured[i] || ' ' }} /> : <span className="pr-8 whitespace-pre">{line || ' '}</span>}
        </div>
      ))}
    </div>
  );
}

function Doc({ f }: { f: MockFile }) {
  const html = useMemo(() => renderMarkdown(f.text).html, [f.text]);
  return <div className="mx-auto max-w-[820px] px-10 pt-8 pb-24"><div className={DOC} dangerouslySetInnerHTML={{ __html: html }} /></div>;
}

/** The tools of the file a tab shows: how it is read, and what is done with it. They sit at the end of the tab strip. */
export function FileTools({ f }: { f: MockFile }) {
  const md = f.path.endsWith('.md');
  const [mode, setMode] = useState<'rendered' | 'source' | 'history'>('rendered');
  const [diff, setDiff] = useState(false);
  return (
    <>
      {md ? <Seg options={[['rendered', 'Rendered'], ['source', 'Source'], ['history', 'History']] as const} current={mode} onPick={setMode} />
        : <Seg options={[['file', 'File'], ['diff', 'Diff']] as const} current={diff ? 'diff' : 'file'} onPick={(v) => setDiff(v === 'diff')} />}
      <BarSep />
      <BarTools>
        <Tool name="note" label="Comment on a selection" />
        <Tool name="copy" label="Copy the path" />
      </BarTools>
    </>
  );
}

/** A file as what it is: a document rendered, code in lines. */
export function FileBody({ f }: { f: MockFile }) {
  return <div className="h-full min-w-0 overflow-auto bg-card">{f.path.endsWith('.md') ? <Doc f={f} /> : <Code f={f} />}</div>;
}

/** One tab: the agent's, which is always first and never closed, or a file's. A file shown but not kept has its name in italics, and gives its tab to the next file shown. */
export interface Tab { readonly id: string; readonly name: string; readonly agent?: boolean; readonly kept?: boolean; readonly title?: string }

/**
 * A pane's tabs, as an editor has them: the one shown is on the pane's own surface, the others on the strip. A click
 * shows a tab, a double click keeps a file's, its × closes it. The shown tab's tools are at the strip's end.
 */
export function Tabs({ tabs, shown, onShow, onKeep, onClose, tools }: { tabs: readonly Tab[]; shown: string; onShow: (id: string) => void; onKeep?: (id: string) => void; onClose?: (id: string) => void; tools?: ReactNode }) {
  return (
    <div className="flex h-11 flex-none items-stretch bg-background" role="tablist">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((t) => {
          const on = t.id === shown;
          return (
            <div key={t.id} role="tab" aria-selected={on} title={t.title ?? t.name} onClick={() => onShow(t.id)} onDoubleClick={() => onKeep?.(t.id)}
              className={cn('group flex max-w-[220px] flex-none cursor-pointer items-center gap-2 border-r pr-2 pl-3.5 text-[13px]', on ? cn(t.agent ? 'bg-background' : 'bg-card', 'text-foreground') : 'border-b text-ink-3 hover:text-foreground')}>
              {t.agent ? <span className="size-[7px] flex-none animate-pulse rounded-full bg-brand" /> : <span className={cn(KIND, 'h-[18px] w-[26px] leading-[18px]')}>{t.name.split('.').pop()}</span>}
              <span className={cn('truncate', on && 'font-bold', !t.agent && !t.kept && 'italic')}>{t.name}</span>
              {t.agent ? <span className="w-1" /> : (
                <button type="button" aria-label={`Close ${t.name}`} onClick={(e) => { e.stopPropagation(); onClose?.(t.id); }}
                  className={cn('flex size-5 flex-none cursor-pointer items-center justify-center rounded-[5px] text-ink-3 hover:bg-hover hover:text-foreground', !on && 'opacity-0 group-hover:opacity-100')}><Icon name="close" size={13} /></button>
              )}
            </div>
          );
        })}
        <div className="min-w-4 flex-1 border-b" />
      </div>
      {tools ? <div className="flex flex-none items-center gap-2 border-b pr-3 pl-2">{tools}</div> : null}
    </div>
  );
}

/* ---- the agent: the real CLI's terminal, stood in for ---- */

/** The terminal's colours are the theme's: what the CLI writes in green, red, yellow, cyan and dim is drawn in the page's own inks. */
const T = {
  dim: 'text-ink-3', teal: 'text-brand', green: 'text-success', red: 'text-destructive', amber: 'text-warning', white: 'text-foreground',
} as const;

/**
 * The terminal the page hosts, with Claude Code in it, drawn as a part of the
 * page: on the page's ground, as the task's column is, a shade apart from
 * the surface a file is read on; in its ink and its code face, light when the
 * page is light. What the CLI draws is its own; its ground, its ink, its
 * sixteen colours, its face and the room round it are the page's. `head` is what the variant puts over it; without one it is the bare
 * terminal.
 */
export function Agent({ head }: { head?: ReactNode }) {
  return (
    <section className="flex h-full min-w-0 flex-col bg-background text-ink-2" aria-label="Agent">
      {head}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full flex-col justify-end px-5 pb-4 font-mono text-[12.5px]/[20px] whitespace-pre-wrap">
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
          <div className="rounded-[8px] border border-border px-3 py-1.5"><span className={T.dim}>&gt; </span><span className="inline-block h-[15px] w-[7px] translate-y-[2px] bg-foreground" /></div>
          <p className={T.dim}>  <span className={T.teal}>⏵⏵ accept edits on</span> · yan/t152 · step v1sz</p>
        </div>
      </div>
    </section>
  );
}

/** What stands over the terminal: the step the session is on, and the terminal's tools, as any pane's bar. */
export function AgentHead({ lead, tools }: { lead?: ReactNode; tools?: ReactNode }) {
  return (
    <div className="flex min-h-14 flex-none items-center gap-2.5 py-2 pr-3.5 pl-5">
      {lead}
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span className="size-[7px] flex-none animate-pulse rounded-full bg-brand" />
        <span className="truncate text-[15px] font-bold text-foreground">{WORKING.title}</span>
      </span>
      <span className="flex flex-none items-center gap-0.5">{tools}</span>
    </div>
  );
}

/** A task's artifacts as a short list, where the Agent layout has no tree: a click shows one in a tab beside the agent, a double click keeps it. */
export function Artifacts({ shown, onFile, onKeep }: { shown: string | null; onFile: (path: string) => void; onKeep: (path: string) => void }) {
  return (
    <div className="flex flex-col gap-px">
      <div className={LABEL}>Artifacts</div>
      {FILES.filter((f) => f.root === 'materials').map((f) => (
        <a key={f.path} className={cn(row({ on: shown === f.path, at: 'tree' }))} href="#" onClick={(e) => { e.preventDefault(); onFile(f.path); }} onDoubleClick={() => onKeep(f.path)}>
          <span className={KIND}>{f.path.split('.').pop()}</span><span className={GROW}>{f.path}</span>
          {f.mark ? <span className={cn('flex-none font-mono text-[11px] font-bold', f.mark === 'A' ? 'text-success' : 'text-warning')}>{f.mark}</span> : null}
        </a>
      ))}
    </div>
  );
}
