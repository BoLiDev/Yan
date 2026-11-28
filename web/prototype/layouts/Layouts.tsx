/*
 * PROTOTYPE. Two layouts, Agent and Workbench.
 *
 *   Agent:      task list | tabs: the agent, then artifacts | the task's column
 *   Workbench:  task list | the task's column | tabs: files | agent session
 *
 * The task's column is headed by the title, on one line, then the blueprint
 * (a mark for each step; it opens a drawer over the page where the path is
 * drawn as a graph down to its destination). Under it, Agent lists the
 * links and the artifacts; Workbench lists artifacts or repositories, picked
 * by a row of toggles, with a mark that keeps only what changed.
 *
 * Files open in tabs, as an editor's do: a click shows a file in the one tab
 * that is not kept (its name in italics), a double click, on the file or on
 * its tab, keeps it. What is open is the same in both layouts; in Agent the
 * agent is the first tab, and is never closed.
 *
 * The layout switch is at the foot of the task list. Nothing says the vault
 * is in step; when it is not, a message comes down at the top of the page
 * (?sync=error shows it).
 */
import { useEffect, useState } from 'react';
import { Seg, Tool } from '@/components/page';
import { fileAt } from './data';
import { PathDrawer } from './PathGraph';
import { setParams, useParam } from './params';
import { Agent, Artifacts, ChangedToggle, FileBody, FileTools, Handle, Links, ModeSwitch, PathRow, Rail, Resizable, ResizablePanel, Tabs, TaskHead, TaskList, Tree, changedCount, type FilesView, type Tab } from './parts';

const AGENT = 'agent';
interface Open { readonly path: string; readonly kept: boolean }

export function Layouts() {
  const [layout] = useParam('layout', 'agent');
  const [drawn, setDrawn] = useParam('path', 'shut');
  const bench = layout === 'workbench';
  const graph = drawn === 'open';
  const [sync] = useParam('sync', 'ok');
  const [list, setList] = useState(true);
  const [first] = useState(() => new URL(location.href).searchParams.get('file'));
  const [files, setFiles] = useState<readonly Open[]>(first && fileAt(first) ? [{ path: first, kept: true }] : []);
  const [shown, setShown] = useState<string>(first && fileAt(first) ? first : AGENT);
  const [view, setView] = useState<FilesView>(fileAt(first ?? '')?.root === 'code' ? 'repositories' : 'materials');
  const [changed, setChanged] = useState(false);
  const pick = (to: boolean): void => setParams({ layout: to ? 'workbench' : 'agent' });

  /** Show a file: in its own tab when it has one, else in the tab that is not kept, else in a new one. */
  const show = (path: string, keep = false): void => {
    setFiles((was) => {
      if (was.some((f) => f.path === path)) return keep ? was.map((f) => (f.path === path ? { ...f, kept: true } : f)) : was;
      const loose = was.findIndex((f) => !f.kept);
      const tab = { path, kept: keep };
      return loose < 0 || keep ? [...was, tab] : was.map((f, i) => (i === loose ? tab : f));
    });
    setShown(path);
  };
  const keep = (path: string): void => show(path, true);
  const close = (path: string): void => {
    const at = files.findIndex((f) => f.path === path);
    const left = files.filter((f) => f.path !== path);
    setFiles(left);
    if (shown === path) setShown(left[Math.min(at, left.length - 1)]?.path ?? AGENT);
  };
  const toggleGraph = (): void => setDrawn(graph ? 'shut' : 'open');
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && graph) return void setDrawn('shut');
      if (!e.ctrlKey) return;
      if (e.key === '1' || e.key === '2') pick(e.key === '2');
      else if (e.key === 'p') toggleGraph();
      else return;
      e.preventDefault();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const fileTabs: Tab[] = files.map((f) => ({ id: f.path, name: f.path.split('/').pop() as string, kept: f.kept, title: f.path }));
  const agentTab: Tab = { id: AGENT, name: 'Agent', agent: true };
  const agentTools = <span className="flex items-center gap-0.5"><Tool name="plus" label="Another shell beside it" small /><Tool name="ban" label="Stop the agent" small /></span>;
  // In the workbench the files have a pane of their own, so one of them is always shown there while any is open.
  const file = fileAt(shown) ?? (bench ? fileAt(files[0]?.path ?? '') : undefined);
  const filePath = file?.path ?? null;

  const column = (
    <aside className="flex h-full flex-col overflow-hidden border-x bg-background" aria-label="Task">
      <div className="flex flex-none flex-col gap-3 px-3 pt-[18px] pb-3">
        <TaskHead />
        <PathRow open={graph} onToggle={toggleGraph} />
        {bench ? (
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1"><Seg wide options={[['materials', 'Artifacts'], ['repositories', 'Repositories']] as const} current={view} onPick={setView} /></div>
            <ChangedToggle on={changed} count={changedCount(view)} onChange={setChanged} />
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-10">
        {bench ? <Tree view={view} changed={changed} file={filePath} onFile={show} onKeep={keep} /> : <><Links /><Artifacts shown={filePath} onFile={show} onKeep={keep} /></>}
      </div>
    </aside>
  );
  const columnPanel = <ResizablePanel defaultSize={bench ? '312px' : '336px'} minSize="260px" maxSize="460px">{column}</ResizablePanel>;
  const left = bench;
  return (
    <div className="flex h-screen">
      {list ? <div className="w-60 flex-none"><TaskList onFold={() => setList(false)} modeFoot={<ModeSwitch bench={bench} onPick={pick} words />} /></div>
        : <Rail onUnfold={() => setList(true)} extra={<ModeSwitch bench={bench} onPick={pick} stacked />} />}
      <Resizable key={layout} className="min-w-0 flex-1">
        {left ? <>{columnPanel}<Handle label="Resize the task's column" /></> : null}
        {bench ? (
          <>
            <ResizablePanel minSize="360px">
              <div className="flex h-full min-w-0 flex-col bg-card">
                <Tabs tabs={fileTabs} shown={filePath ?? ''} onShow={setShown} onKeep={keep} onClose={close} tools={file ? <FileTools key={file.path} f={file} /> : null} />
                <div className="min-h-0 flex-1">{file ? <FileBody f={file} /> : null}</div>
              </div>
            </ResizablePanel>
            <Handle label="Resize the agent" />
            <ResizablePanel defaultSize={30} minSize="320px">
              <div className="flex h-full min-w-0 flex-col border-l bg-background"><Tabs tabs={[agentTab]} shown={AGENT} onShow={() => {}} tools={agentTools} /><div className="min-h-0 flex-1"><Agent /></div></div>
            </ResizablePanel>
          </>
        ) : (
          <ResizablePanel minSize="320px">
            <div className="flex h-full min-w-0 flex-col bg-card">
              <Tabs tabs={[agentTab, ...fileTabs]} shown={file ? file.path : AGENT} onShow={setShown} onKeep={keep} onClose={close} tools={file ? <FileTools key={file.path} f={file} /> : agentTools} />
              {/* The agent stays drawn under a file's tab, as a terminal must: it is hidden, not ended. */}
              <div className={file ? 'hidden' : 'min-h-0 flex-1'}><Agent /></div>
              {file ? <div className="min-h-0 flex-1"><FileBody f={file} /></div> : null}
            </div>
          </ResizablePanel>
        )}
        {left ? null : <><Handle label="Resize the task's column" />{columnPanel}</>}
      </Resizable>
      {sync === 'error' ? (
        <div role="alert" className="fixed top-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-card py-2 pr-2 pl-3.5 text-[13px] shadow-[0_0_0_1px_var(--line),0_10px_30px_-8px_var(--shadow-strong)]">
          <span className="size-2 flex-none rounded-full bg-warning ring-3 ring-warning-soft" />
          <span>Can't reach origin. What changed here is kept and tried again.</span>
          <button type="button" className="cursor-pointer rounded-lg bg-hover px-2.5 py-1 hover:bg-foreground/10">Try now</button>
        </div>
      ) : null}
      <PathDrawer open={graph} onClose={() => setDrawn('shut')} onFile={(p) => { setDrawn('shut'); keep(p); }} />
    </div>
  );
}
