/*
 * PROTOTYPE D, after the first round of feedback on A and B.
 *
 *   Agent:      task list | agent session | the task's details
 *   Workbench:  task list | repositories and files | the file | agent session
 *
 * The details column keeps to what names the task or is looked at all the
 * time: its title, the switch, the destination as one row (how far it is
 * met; its words open under it), then the path, which has the room, with
 * the change that re-routed it drawn where it happened. In the workbench the
 * agent moves to the right of the file, and the details give way to the files.
 */
import { useState } from 'react';
import { Seg, Tool } from '@/components/page';
import { fileAt } from './data';
import { setParams, useParam } from './params';
import { Agent, AgentHead, DestinationRow, FileView, Handle, Links, Rail, Resizable, ResizablePanel, Steps, TaskHead, TaskList, Tree } from './parts';

const LAYOUTS = [['agent', 'Agent'], ['workbench', 'Workbench']] as const;

export function VariantD() {
  const [layout] = useParam('layout', 'agent');
  const [path] = useParam('file', 'spec.md');
  const bench = layout === 'workbench';
  const [list, setList] = useState(true);
  const file = fileAt(path) ?? fileAt('spec.md');
  const open = (p: string): void => setParams({ layout: 'workbench', file: p });
  const head = (
    <div className="flex flex-none flex-col gap-4 px-3 pt-[18px] pb-3">
      <TaskHead />
      <Seg wide options={LAYOUTS} current={bench ? 'workbench' : 'agent'} onPick={(v) => setParams({ layout: v })} />
    </div>
  );
  const agent = <Agent column={!bench} head={<AgentHead tools={<><Tool name="plus" label="Another shell beside it" small /><Tool name="ban" label="Stop the agent" small /></>} />} />;
  return (
    <div className="flex h-screen">
      {list ? <div className="w-60 flex-none"><TaskList onFold={() => setList(false)} /></div> : <Rail onUnfold={() => setList(true)} />}
      {bench && file ? (
        <Resizable key="workbench" className="min-w-0 flex-1">
          <ResizablePanel defaultSize="288px" minSize="240px" maxSize="460px">
            <aside className="flex h-full flex-col overflow-hidden border-r bg-background" aria-label="Files">
              {head}
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-24"><Tree file={file.path} onFile={open} /></div>
            </aside>
          </ResizablePanel>
          <Handle label="Resize the files" />
          <ResizablePanel minSize="360px"><FileView f={file} /></ResizablePanel>
          <Handle label="Resize the agent" dark />
          <ResizablePanel defaultSize={30} minSize="320px">{agent}</ResizablePanel>
        </Resizable>
      ) : (
        <Resizable key="agent" className="min-w-0 flex-1">
          <ResizablePanel minSize="320px">{agent}</ResizablePanel>
          <Handle label="Resize the details" dark />
          <ResizablePanel defaultSize="336px" minSize="240px" maxSize="460px">
            <aside className="flex h-full flex-col overflow-hidden bg-background" aria-label="Task">
              {head}
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-24"><DestinationRow /><Steps onFile={open} change /><Links /></div>
            </aside>
          </ResizablePanel>
        </Resizable>
      )}
    </div>
  );
}
