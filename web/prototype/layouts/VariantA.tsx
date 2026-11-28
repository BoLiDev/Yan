/*
 * PROTOTYPE A. Two named layouts, "Agent" and "Files", and a switch that sits
 * on the task, at the head of its column. v1's columns kept: the task list at
 * the far left, a column for the task, and the rest for what is shown.
 *
 *   Agent:  task list | agent, the widest | the task (destination, path, links)
 *   Files:  rail | agent, narrow | the task (its files) | the file
 *
 * The agent never leaves the task list's side; the task's column is whatever
 * is to the agent's right. Picking a step's file from the path goes to Files.
 */
import { useState } from 'react';
import { Seg, Tool } from '@/components/page';
import { fileAt } from './data';
import { setParams, useParam } from './params';
import { Agent, AgentHead, Destination, FileView, Handle, Links, Rail, Resizable, ResizablePanel, Steps, TaskHead, TaskList, Tree } from './parts';

const LAYOUTS = [['agent', 'Agent'], ['files', 'Files']] as const;

export function VariantA() {
  const [layout] = useParam('layout', 'agent');
  const [path] = useParam('file', 'spec.md');
  const files = layout === 'files';
  const [list, setList] = useState<boolean | null>(null);
  // The task list gives way in Files unless it was asked for.
  const listShown = list ?? !files;
  const file = fileAt(path) ?? fileAt('spec.md');
  const open = (p: string): void => setParams({ layout: 'files', file: p });
  const pick = <Seg wide options={LAYOUTS} current={files ? 'files' : 'agent'} onPick={(v) => { setList(null); setParams({ layout: v }); }} />;
  return (
    <div className="flex h-screen">
      {listShown ? <div className="w-60 flex-none"><TaskList onFold={() => setList(false)} /></div> : <Rail onUnfold={() => setList(true)} />}
      <Resizable key={layout} className="min-w-0 flex-1">
        <ResizablePanel defaultSize={files ? 32 : undefined} minSize="320px">
          <Agent column={!files} head={<AgentHead tools={<><Tool name="plus" label="Another shell beside it" small /><Tool name="ban" label="Stop the agent" small /></>} />} />
        </ResizablePanel>
        <Handle label="Resize the agent" dark />
        <ResizablePanel defaultSize={files ? '288px' : '336px'} minSize="240px" maxSize="460px">
          <aside className="flex h-full flex-col overflow-hidden border-r bg-background" aria-label="Task">
            <div className="flex flex-none flex-col gap-4 px-3 pt-[18px] pb-3"><TaskHead />{pick}</div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-24">
              {files ? <Tree file={file?.path ?? null} onFile={open} /> : <><Destination /><Steps onFile={open} /><Links /></>}
            </div>
          </aside>
        </ResizablePanel>
        {files && file ? <><Handle label="Resize the files" /><ResizablePanel minSize="360px"><FileView f={file} /></ResizablePanel></> : null}
      </Resizable>
    </div>
  );
}
