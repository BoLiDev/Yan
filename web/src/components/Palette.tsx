import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { findTasks, type Found } from '../lib/find';
import { MOD } from '../lib/format';
import { link, useRoute } from '../lib/route';
import { openAgent } from '../state/agentTab';
import { useIndex } from '../state/server';
import { useUI } from '../state/ui';
import { cn } from '../lib/utils';
import { Icon, StateIcon } from './Icon';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Kbd } from './ui/kbd';

/** A title with the parts that matched what was typed marked. */
export function Marked({ text, marks }: { text: string; marks: Found['marks'] }) {
  const out: ReactNode[] = [];
  let from = 0;
  for (const [start, end] of marks) {
    if (start < from) continue;
    out.push(text.slice(from, start), <mark key={start}>{text.slice(start, end)}</mark>);
    from = end;
  }
  out.push(text.slice(from));
  return <>{out}</>;
}

/**
 * ⌘K: a box over the page to go to a task by typing, as Notion's search is.
 * The best match is picked from the start, so Enter goes to it; ↑ and ↓ (or
 * Tab, or Ctrl with N and P) pick another, and Mod+Enter opens the picked
 * task's Agent instead, in the tab every agent opens in. With nothing typed
 * it offers the tasks visited last, the one being read left out, so ⌘K then
 * Enter goes back to the one before. The box is Base UI's dialog: Escape or
 * a click outside closes it and gives the keyboard back where it was.
 */
export function Palette() {
  const open = useUI((s) => s.palette);
  // Gone to a task, the keyboard stays with the page that shows it rather than going back where it was.
  const went = useRef(false);
  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (next) went.current = false;
      useUI.setState({ palette: next });
    }}>
      <DialogContent showCloseButton={false} finalFocus={() => !went.current}
        className="top-[12vh] flex max-h-[70vh] max-w-[620px] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-[620px]">
        <DialogTitle className="sr-only">Go to a task</DialogTitle>
        {open ? <PaletteBox onGone={() => { went.current = true; }} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBox({ onGone }: { onGone: () => void }) {
  const { data: index } = useIndex();
  const recent = useUI((s) => s.recent);
  const r = useRoute();
  const current = r.view === 'task' ? r.id : null;
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const found = useMemo(() => (index ? findTasks(index.tasks, query, recent, current) : []), [index, query, recent, current]);
  const list = useRef<HTMLDivElement>(null);

  // In a block: scrollIntoView returns a promise in newer browsers, which React would take for a cleanup.
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, found]);

  const go = (f: Found | undefined, agent: boolean): void => {
    if (!f) return;
    const [, where] = f.task.agents[0] ?? [];
    if (agent && where) {
      useUI.setState({ palette: false });
      openAgent(where);
      return;
    }
    onGone();
    useUI.setState({ palette: false });
    location.hash = link.task(f.task.id);
  };
  const move = (by: number): void => setAt((a) => Math.max(0, Math.min(found.length - 1, a + by)));

  return (
    <>
      <label className="flex h-13 flex-none items-center gap-2.5 border-b px-4 text-muted-foreground">
        <Icon name="search" size={17} />
        <input autoFocus placeholder="Go to a task" aria-label="Go to a task" value={query} role="combobox" aria-expanded aria-controls="palette-list"
          aria-activedescendant={found[at] ? `palette-${found[at].task.id}` : undefined}
          className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
          onChange={(e) => {
            setQuery(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            const ctrl = e.ctrlKey && !e.metaKey;
            // Tab picks as it does in a task's nav, and keeps the keyboard in the box.
            if (e.key === 'ArrowDown' || (ctrl && e.key === 'n') || (e.key === 'Tab' && !e.shiftKey)) move(1);
            else if (e.key === 'ArrowUp' || (ctrl && e.key === 'p') || (e.key === 'Tab' && e.shiftKey)) move(-1);
            else if (e.key === 'Enter' && !e.nativeEvent.isComposing) go(found[at], e.metaKey || e.ctrlKey);
            else return;
            e.preventDefault();
          }} />
      </label>
      <div className="overflow-y-auto p-1.5" id="palette-list" role="listbox" ref={list}>
        {found.length === 0 ? <div className="px-3 py-4.5 text-[13.5px] text-muted-foreground">{query.trim() ? 'No task matches' : 'No open task'}</div> : null}
        {found.map((f, i) => (
          <div key={f.task.id}>
            {f.group && f.group !== found[i - 1]?.group ? <div className="px-2.5 pt-2 pb-1 text-xs font-bold text-muted-foreground">{f.group}</div> : null}
            <div id={`palette-${f.task.id}`} role="option" aria-selected={i === at}
              className="group/option flex h-10 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 aria-selected:bg-hover"
              onMouseMove={() => setAt(i)} onClick={(e) => go(f, e.metaKey || e.ctrlKey)}>
              <StateIcon state={f.task.state} />
              <span className={cn('min-w-0 truncate [&_mark]:bg-transparent [&_mark]:font-bold [&_mark]:text-inherit', (f.task.state === 'done' || f.task.state === 'abandoned') && 'text-muted-foreground')}>
                <Marked text={f.task.title || f.task.id} marks={f.marks} />
              </span>
              <span className="flex-none text-xs text-muted-foreground tabular-nums">{f.task.id}</span>
              <span className="flex-1" />
              {f.task.agents.length ? <span className="flex flex-none items-center gap-1 text-xs text-muted-foreground" title={`${MOD}↵ opens its Agent`}><Icon name="cloud" size={14} />Agent</span> : null}
              <Kbd className="invisible group-aria-selected/option:visible" aria-hidden="true">↵</Kbd>
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-none items-center gap-3.5 border-t px-3.5 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> to move</span>
        <span className="flex items-center gap-1"><Kbd>↵</Kbd> to open</span>
        <span className="flex items-center gap-1"><Kbd>{MOD}↵</Kbd> its Agent</span>
        <span className="flex-1" />
        <span className="flex items-center gap-1"><Kbd>esc</Kbd> to close</span>
      </div>
    </>
  );
}
