/*
 * PROTOTYPE. Two layouts, Agent and Workbench.
 *
 *   Agent:      task list | agent session | the task's column (its details)
 *   Workbench:  task list | the task's column (its files) | the file | agent session
 *
 * The layout is picked in the task list's head (and on its rail), the one
 * place that is the same in both, so the switch itself never moves. The
 * task's column is headed by the title, on one line; in Agent it lists the
 * destination as one row, the path and the links; in Workbench a row of
 * toggles picks materials or repositories, and "Changed" keeps only what
 * changed.
 *
 * ?details=left puts the task's column left of the agent in Agent too, so
 * the title and the agent keep their sides when the layout is switched.
 */
import { useEffect, useState } from 'react';
import { Seg, Tool } from '@/components/page';
import { fileAt } from './data';
import { setParams, useParam } from './params';
import { Agent, AgentHead, ChangedToggle, DestinationRow, FileView, Handle, Links, ModeSwitch, Rail, Resizable, ResizablePanel, Steps, TaskHead, TaskList, Tree, changedCount, type FilesView } from './parts';

export function Layouts() {
  const [layout] = useParam('layout', 'agent');
  const [path] = useParam('file', 'spec.md');
  const [side] = useParam('details', 'right');
  const bench = layout === 'workbench';
  const [list, setList] = useState(true);
  const [view, setView] = useState<FilesView>(fileAt(path)?.root === 'code' ? 'repositories' : 'materials');
  const [changed, setChanged] = useState(false);
  const file = fileAt(path) ?? fileAt('spec.md');
  const pick = (to: boolean): void => setParams({ layout: to ? 'workbench' : 'agent' });
  const open = (p: string): void => {
    setView(fileAt(p)?.root === 'code' ? 'repositories' : 'materials');
    setParams({ layout: 'workbench', file: p });
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || (e.key !== '1' && e.key !== '2')) return;
      e.preventDefault();
      pick(e.key === '2');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const agent = <Agent column={!bench} head={<AgentHead tools={<><Tool name="plus" label="Another shell beside it" small /><Tool name="ban" label="Stop the agent" small /></>} />} />;
  const column = (
    <aside className="flex h-full flex-col overflow-hidden border-r bg-background" aria-label="Task">
      <div className="flex flex-none flex-col gap-3.5 px-3 pt-[18px] pb-3">
        <TaskHead />
        {bench ? (
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1"><Seg wide options={[['materials', 'Materials'], ['repositories', 'Repositories']] as const} current={view} onPick={setView} /></div>
            <ChangedToggle on={changed} count={changedCount(view)} onChange={setChanged} />
          </div>
        ) : null}
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-24">
        {bench ? <Tree view={view} changed={changed} file={file?.path ?? null} onFile={open} /> : <><DestinationRow /><Steps onFile={open} change /><Links /></>}
      </div>
    </aside>
  );
  const columnPanel = <ResizablePanel defaultSize={bench ? '312px' : '336px'} minSize="260px" maxSize="460px">{column}</ResizablePanel>;
  const left = bench || side === 'left';
  return (
    <div className="flex h-screen">
      {list ? <div className="w-60 flex-none"><TaskList onFold={() => setList(false)} mode={<ModeSwitch bench={bench} onPick={pick} />} /></div>
        : <Rail onUnfold={() => setList(true)} extra={<ModeSwitch bench={bench} onPick={pick} stacked />} />}
      <Resizable key={`${layout}|${side}`} className="min-w-0 flex-1">
        {left ? <>{columnPanel}<Handle label="Resize the task's column" /></> : null}
        {bench && file ? <><ResizablePanel minSize="360px"><FileView f={file} /></ResizablePanel><Handle label="Resize the agent" dark /></> : null}
        <ResizablePanel defaultSize={bench ? 30 : undefined} minSize="320px">{agent}</ResizablePanel>
        {left ? null : <><Handle label="Resize the task's column" dark />{columnPanel}</>}
      </Resizable>
    </div>
  );
}
