/*
 * PROTOTYPE C. No task list column at all: a bar across the top holds the
 * task (picked from a menu), its path drawn along the bar, and the switch
 * between two layouts named for what the user is doing, "Talk" and "Read".
 *
 *   Talk:  the path | the agent, a card in the middle of the page | the destination
 *   Read:  agent, narrow, edge to edge | the files | the file
 */
import { Icon } from '@/components/Icon';
import { GROW, SHIMMER, Seg, Tool } from '@/components/page';
import { cn } from '@/lib/utils';
import { STEPS, TASK, TASKS, WORKING, fileAt } from './data';
import { setParams, useParam } from './params';
import { Agent, AgentHead, Destination, FileView, Handle, Links, Resizable, ResizablePanel, StepMark, Steps, TaskMark, Tree } from './parts';

const LAYOUTS = [['talk', 'Talk'], ['read', 'Read']] as const;

/** The path along the bar: a mark for each step, joined, the one in work named. */
function PathStrip() {
  return (
    <div className="flex min-w-0 flex-1 items-center justify-center gap-0" title="The path">
      {STEPS.map((s, i) => (
        <span key={s.id} className="flex flex-none items-center" title={`${s.kind} · ${s.title}`}>
          {i ? <span className={cn('h-px w-3.5', s.state === 'done' ? 'bg-success' : 'bg-border')} /> : null}
          {s.state === 'working'
            ? <span className="mx-1 flex h-7 items-center gap-1.5 rounded-full bg-card pr-3 pl-2 text-[12.5px] ring-1 ring-border"><StepMark state={s.state} size={14} /><span className={cn('max-w-[260px] truncate', SHIMMER)}>{s.title}</span></span>
            : <StepMark state={s.state} size={14} />}
        </span>
      ))}
    </div>
  );
}

function TopBar({ read }: { read: boolean }) {
  const waiting = TASKS.filter((t) => t.dot).length;
  return (
    <header className="flex h-[52px] flex-none items-center gap-3 border-b bg-sunken pr-3 pl-4">
      <b className="text-[22px] tracking-tight">yan</b>
      <button type="button" className="flex h-[34px] max-w-[320px] min-w-0 cursor-pointer items-center gap-2 rounded-[10px] bg-card pr-2 pl-2.5 text-[13.5px] font-bold ring-1 ring-border" title="Pick a task (Ctrl+F)">
        <TaskMark state={TASK.state} /><span className={GROW}>{TASK.title}</span><Icon name="unfold" size={14} className="text-ink-3" />
      </button>
      {waiting ? <span className="flex flex-none items-center gap-1.5 text-[12.5px] text-ink-3"><span className="size-[7px] rounded-full bg-warning" />{waiting} other tasks have news</span> : null}
      <PathStrip />
      <Seg options={LAYOUTS} current={read ? 'read' : 'talk'} onPick={(v) => setParams({ layout: v })} />
      <span className="flex items-center gap-0.5">
        <Tool name="plus" label="New task" small /><Tool name="note" label="Drafts" small /><Tool name="janus" label="Janus" small /><Tool name="settings" label="Settings" small />
      </span>
    </header>
  );
}

export function VariantC() {
  const [layout] = useParam('layout', 'talk');
  const [path] = useParam('file', 'spec.md');
  const read = layout === 'read';
  const file = fileAt(path) ?? fileAt('spec.md');
  const open = (p: string): void => setParams({ layout: 'read', file: p });
  return (
    <div className="flex h-screen flex-col">
      <TopBar read={read} />
      {read && file ? (
        <Resizable className="min-h-0 flex-1">
          <ResizablePanel defaultSize={30} minSize="320px"><Agent /></ResizablePanel>
          <Handle label="Resize the agent" dark />
          <ResizablePanel defaultSize="272px" minSize="220px" maxSize="420px">
            <aside className="flex h-full flex-col gap-4 overflow-y-auto border-r bg-background px-3 pt-4 pb-24" aria-label="Files"><Tree file={file.path} onFile={open} /></aside>
          </ResizablePanel>
          <Handle label="Resize the files" />
          <ResizablePanel minSize="360px"><FileView f={file} /></ResizablePanel>
        </Resizable>
      ) : (
        <div className="flex min-h-0 flex-1 justify-center gap-5 px-5 pt-5">
          <aside className="flex w-[300px] flex-none flex-col gap-4 overflow-y-auto pb-24 max-[1280px]:hidden" aria-label="Path"><Steps onFile={open} /></aside>
          <div className="mb-5 flex min-w-0 max-w-[980px] flex-1 flex-col overflow-hidden rounded-[14px] shadow-[0_1px_0_var(--shadow-line),0_12px_32px_-12px_var(--shadow-strong)]">
            <Agent head={<AgentHead tools={<><Tool name="plus" label="Another shell beside it" small /><Tool name="ban" label="Stop the agent" small /></>} />} />
          </div>
          <aside className="flex w-[300px] flex-none flex-col gap-4 overflow-y-auto pb-24" aria-label="Destination">
            <Destination /><Links />
            <p className="px-2.5 text-[12px]/[18px] text-ink-3">Working <b>{WORKING.title}</b>, on <span className="font-mono">yan/t152</span>.</p>
          </aside>
        </div>
      )}
    </div>
  );
}
