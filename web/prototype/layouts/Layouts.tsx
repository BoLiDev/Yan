/*
 * PROTOTYPE. Two layouts, Agent and Workbench.
 *
 *   Agent:      task list | the task's column | agent session
 *   Workbench:  task list | the task's column | the file | agent session
 *
 * The task's column is headed by the title, on one line, then one row that
 * is the same in both layouts: the blueprint (a mark for each step; it opens
 * a drawer over the page where the path is drawn as a graph down to its
 * destination). Under them, Agent lists what is worked now,
 * what is ready next and the links; Workbench lists artifacts or
 * repositories, picked by a row of toggles, with a mark that keeps only what
 * changed.
 *
 * The layout switch is at the foot of the task list, where the vault's light
 * was. Still being compared, from the button at the bottom right: which side
 * of the agent the task's column is on in Agent (?details=left|right).
 */
import { useEffect, useState } from 'react';
import { Seg, Tool } from '@/components/page';
import { fileAt } from './data';
import { PathDrawer } from './PathGraph';
import { setParams, useParam } from './params';
import { Agent, AgentHead, ChangedToggle, FileView, Handle, Links, ModeSwitch, Now, PathRow, Rail, Resizable, ResizablePanel, TaskHead, TaskList, Tree, changedCount, type FilesView } from './parts';

export function Layouts() {
  const [layout] = useParam('layout', 'agent');
  const [path] = useParam('file', 'spec.md');
  const [side] = useParam('details', 'left');
  const [drawn, setDrawn] = useParam('path', 'shut');
  const bench = layout === 'workbench';
  const graph = drawn === 'open';
  const [list, setList] = useState(true);
  const [view, setView] = useState<FilesView>(fileAt(path)?.root === 'code' ? 'repositories' : 'materials');
  const [changed, setChanged] = useState(false);
  const file = fileAt(path) ?? fileAt('spec.md');
  const pick = (to: boolean): void => setParams({ layout: to ? 'workbench' : 'agent' });
  const open = (p: string): void => {
    setView(fileAt(p)?.root === 'code' ? 'repositories' : 'materials');
    setParams({ layout: 'workbench', file: p });
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

  const agent = <Agent column={!bench} head={<AgentHead tools={<><Tool name="plus" label="Another shell beside it" small /><Tool name="ban" label="Stop the agent" small /></>} />} />;
  const column = (
    <aside className="flex h-full flex-col overflow-hidden border-r bg-background" aria-label="Task">
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
        {bench ? <Tree view={view} changed={changed} file={file?.path ?? null} onFile={open} /> : <><Now onFile={open} /><Links /></>}
      </div>
    </aside>
  );
  const columnPanel = <ResizablePanel defaultSize={bench ? '312px' : '336px'} minSize="260px" maxSize="460px">{column}</ResizablePanel>;
  const left = bench || side === 'left';
  const words = <ModeSwitch bench={bench} onPick={pick} words />;
  return (
    <div className="flex h-screen">
      {list ? (
        <div className="w-60 flex-none">
          <TaskList onFold={() => setList(false)} modeFoot={words} />
        </div>
      ) : <Rail onUnfold={() => setList(true)} extra={<ModeSwitch bench={bench} onPick={pick} stacked />} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <Resizable key={`${layout}|${side}`} className="min-h-0 flex-1">
          {left ? <>{columnPanel}<Handle label="Resize the task's column" /></> : null}
          {bench && file ? <><ResizablePanel minSize="360px"><FileView f={file} /></ResizablePanel><Handle label="Resize the agent" dark /></> : null}
          <ResizablePanel defaultSize={bench ? 30 : undefined} minSize="320px">{agent}</ResizablePanel>
          {left ? null : <><Handle label="Resize the task's column" dark />{columnPanel}</>}
        </Resizable>
      </div>
      <PathDrawer open={graph} onClose={() => setDrawn('shut')} onFile={(p) => { setDrawn('shut'); open(p); }} />
    </div>
  );
}
