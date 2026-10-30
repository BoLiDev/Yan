import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { findTasks, type Found } from '../lib/find';
import { MOD } from '../lib/format';
import { AGENT_TAB, link, useRoute } from '../lib/route';
import { useIndex } from '../state/server';
import { useUI } from '../state/ui';
import { Icon, StateIcon } from './Icon';

/** A title with the parts that matched what was typed marked. */
function Marked({ text, marks }: { text: string; marks: Found['marks'] }) {
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
 * The best match is picked from the start, so Enter goes to it; ↑ and ↓
 * pick another, and Mod+Enter opens the picked task's Agent instead, in the
 * tab every agent opens in. With nothing typed it offers the tasks visited
 * last, the one being read left out, so ⌘K then Enter goes back to the one
 * before. Going to a task puts the keyboard on its Overview row; Escape
 * gives it back where it was.
 */
export function Palette() {
  const open = useUI((s) => s.palette);
  return open ? <PaletteBox /> : null;
}

function PaletteBox() {
  const { data: index } = useIndex();
  const recent = useUI((s) => s.recent);
  const r = useRoute();
  const current = r.view === 'task' ? r.id : null;
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const found = useMemo(() => (index ? findTasks(index.tasks, query, recent, current) : []), [index, query, recent, current]);
  const list = useRef<HTMLDivElement>(null);
  const before = useRef(document.activeElement as HTMLElement | null);

  useEffect(() => {
    setAt(0);
  }, [query]);
  // In a block: scrollIntoView returns a promise in newer browsers, which React would take for a cleanup.
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [at, found]);

  const close = (back: boolean): void => {
    useUI.setState({ palette: false });
    if (back) before.current?.focus({ preventScroll: true });
  };
  const go = (f: Found | undefined, agent: boolean): void => {
    if (!f) return;
    const [, where] = f.task.agents[0] ?? [];
    if (agent && where) {
      close(true);
      window.open(where, AGENT_TAB);
      return;
    }
    close(false);
    location.hash = link.task(f.task.id);
    useUI.setState((s) => ({ navFocus: s.navFocus + 1 }));
  };
  const move = (by: number): void => setAt((a) => Math.max(0, Math.min(found.length - 1, a + by)));

  return (
    <div className="palette-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) close(true); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Go to a task">
        <label className="palette-input">
          <Icon name="search" size={17} />
          <input autoFocus placeholder="Go to a task" aria-label="Go to a task" value={query} role="combobox" aria-expanded aria-controls="palette-list"
            aria-activedescendant={found[at] ? `palette-${found[at].task.id}` : undefined}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              const ctrl = e.ctrlKey && !e.metaKey;
              if (e.key === 'ArrowDown' || (ctrl && e.key === 'n')) move(1);
              else if (e.key === 'ArrowUp' || (ctrl && e.key === 'p')) move(-1);
              else if (e.key === 'Enter' && !e.nativeEvent.isComposing) go(found[at], e.metaKey || e.ctrlKey);
              else if (e.key === 'Escape') close(true);
              else return;
              e.preventDefault();
            }} />
        </label>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {found.length === 0 ? <div className="palette-none">{query.trim() ? 'No task matches' : 'No open task'}</div> : null}
          {found.map((f, i) => (
            <div key={f.task.id}>
              {f.group && f.group !== found[i - 1]?.group ? <div className="palette-group">{f.group}</div> : null}
              <div id={`palette-${f.task.id}`} role="option" aria-selected={i === at} className={'palette-item' + (f.task.state === 'done' || f.task.state === 'abandoned' ? ' closed' : '')}
                onMouseMove={() => setAt(i)} onClick={(e) => go(f, e.metaKey || e.ctrlKey)}>
                <StateIcon state={f.task.state} />
                <span className="name"><Marked text={f.task.title || f.task.id} marks={f.marks} /></span>
                <span className="id">{f.task.id}</span>
                <span className="grow" />
                {f.task.agents.length ? <span className="agent" title={`${MOD}↵ opens its Agent`}><Icon name="cloud" size={14} />Agent</span> : null}
                <span className="enter" aria-hidden="true">↵</span>
              </div>
            </div>
          ))}
        </div>
        <div className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> to move</span>
          <span><kbd>↵</kbd> to open</span>
          <span><kbd>{MOD}↵</kbd> its Agent</span>
          <span className="grow" />
          <span><kbd>esc</kbd> to close</span>
        </div>
      </div>
    </div>
  );
}
