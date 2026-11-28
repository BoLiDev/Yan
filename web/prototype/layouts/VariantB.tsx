/*
 * PROTOTYPE B. One layout and no mode to name. The order never changes:
 * rail, agent, the task's column, a file. With no file open the agent has
 * the room; opening one (from the path or the tree) narrows the agent and
 * the file takes the right; closing it gives the room back. "Switching" is
 * opening and closing a file, or dragging the file's edge shut.
 *
 * The task's column lists one of two things, picked at its head: the path
 * (with the destination) or the files. That pick is what the column lists,
 * not a layout.
 */
import { useState } from 'react';
import { Seg, Tool } from '@/components/page';
import { fileAt } from './data';
import { useParam } from './params';
import { Agent, AgentHead, Destination, FileView, Handle, Links, Rail, Resizable, ResizablePanel, Steps, TaskHead, TaskList, Tree } from './parts';

export function VariantB() {
  const [path, setPath] = useParam('file', '');
  const file = fileAt(path);
  const [lists, setLists] = useState<'path' | 'files'>('path');
  const [list, setList] = useState(false);
  const open = (p: string): void => setPath(p);
  return (
    <div className="flex h-screen">
      {list ? <div className="w-60 flex-none"><TaskList onFold={() => setList(false)} /></div> : <Rail onUnfold={() => setList(true)} />}
      <Resizable key={file ? 'open' : 'shut'} className="min-w-0 flex-1">
        <ResizablePanel defaultSize={file ? 34 : undefined} minSize="320px">
          <Agent column={!file} head={<AgentHead tools={<>
            {file ? <Tool name="expand" label="Give the agent the room (closes the file)" onClick={() => setPath(null)} small /> : null}
            <Tool name="plus" label="Another shell beside it" small /><Tool name="ban" label="Stop the agent" small />
          </>} />} />
        </ResizablePanel>
        <Handle label="Resize the agent" dark />
        <ResizablePanel defaultSize={file ? '288px' : '336px'} minSize="240px" maxSize="460px">
          <aside className="flex h-full flex-col overflow-hidden border-r bg-background" aria-label="Task">
            <div className="flex flex-none flex-col gap-4 px-3 pt-[18px] pb-3">
              <TaskHead />
              <Seg wide options={[['path', 'Path'], ['files', 'Files']] as const} current={lists} onPick={setLists} />
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 pb-24">
              {lists === 'files' ? <Tree file={file?.path ?? null} onFile={open} /> : <><Destination /><Steps onFile={open} picked={file?.step} /><Links /></>}
            </div>
          </aside>
        </ResizablePanel>
        {file ? <><Handle label="Resize the file" /><ResizablePanel minSize="360px"><FileView f={file} onClose={() => setPath(null)} /></ResizablePanel></> : null}
      </Resizable>
    </div>
  );
}
