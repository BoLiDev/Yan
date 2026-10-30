import { useEffect, useRef } from 'react';
import type { Index, TaskDetail } from './lib/api';
import { foldersAbove } from './lib/files';
import { parseRoute, useHash, useRoute, type Route } from './lib/route';
import { listResources } from './lib/resources';
import { nextStop, taskStops } from './lib/stops';
import { Icon } from './components/Icon';
import { Palette } from './components/Palette';
import { AskModal, Toast } from './components/ui';
import { Left } from './panes/Left';
import { Middle } from './panes/Middle';
import { Right, lookAt } from './panes/Right';
import { followAgent, noAgent, useAgentTab } from './state/agentTab';
import { connect, queryClient, useIndex, useTask } from './state/server';
import { setPref, useUI } from './state/ui';

/**
 * What moving to a route does besides showing it: a source view is left,
 * the visit to the task left behind ends, where the task is is kept for its
 * row in the list, the folders above a file open, and opening a file or the
 * report is a look at it.
 */
function useRouteEffects(): void {
  const hash = useHash();
  const r = useRoute();
  const { data: index } = useIndex();
  const before = useRef<Route | null>(null);
  useEffect(() => {
    const was = before.current;
    before.current = r;
    useUI.setState({ pageSource: false });
    if (was?.view === 'task' && (r.view !== 'task' || r.id !== was.id)) {
      useUI.setState((s) => {
        const { [was.id]: _p, ...problemBase } = s.problemBase;
        const { [was.id]: _l, ...logBase } = s.logBase;
        return { problemBase, logBase };
      });
    }
    if (r.view === 'task') useUI.setState((s) => ({ last: { ...s.last, [r.id]: hash } }));
    // What ⌘K offers before anything is typed: the tasks visited, the last first.
    if (r.view === 'task' && (was?.view !== 'task' || was.id !== r.id)) useUI.setState((s) => ({ recent: [r.id, ...s.recent.filter((id) => id !== r.id)].slice(0, 20) }));
    // The log marks itself read as it opens, after noting where the visit started.
    if (index && !(r.view === 'task' && r.sub === 'log')) lookAt(r, index);
    // Only when the route moves, or once the index first arrives.
  }, [hash, !!index]);

  // A file asked for opens the folders above it.
  const id = r.view === 'task' && (r.sub === 'file' || r.sub === 'folder') ? r.id : undefined;
  const { data: d } = useTask(id);
  useEffect(() => {
    if (!d || r.view !== 'task' || (r.sub !== 'file' && r.sub !== 'folder')) return;
    openTo(d, r.sub === 'file' ? foldersAbove(r.path) : [r.path, ...foldersAbove(r.path)]);
  }, [hash, !!d]);
}

/**
 * Going to a task sends the agent tab, while this page holds it, to the
 * task's first agent, or to yan serve's page saying it keeps none; and
 * when a task that kept none gets one while it is read, to that one.
 */
function useAgentFollow(): void {
  const r = useRoute();
  const { data: index } = useIndex();
  const id = r.view === 'task' ? r.id : null;
  const first = id === null ? undefined : index?.tasks.find((t) => t.id === id)?.agents[0]?.[1];
  const went = useRef<string | null>(null);
  useEffect(() => {
    if (id === null || !index) return;
    const moved = went.current !== id;
    went.current = id;
    if (moved || (first !== undefined && useAgentTab.getState().showing === noAgent(id))) followAgent(first ?? noAgent(id));
  }, [id, first, !!index]);
}

function openTo(d: TaskDetail, folders: readonly string[]): void {
  const want = folders.filter(Boolean);
  if (!want.length) return;
  useUI.setState((s) => {
    const kept = s.open[d.id] ?? [];
    return { open: { ...s.open, [d.id]: [...new Set([...kept, ...want])] } };
  });
}

/**
 * ⌘K goes to a task; Tab and Shift+Tab move through the open task's nav,
 * showing each row as they reach it, round and round, and never anywhere
 * else on the page, so no focus ring is drawn, its Agent and Resources
 * taking ↑, ↓ and Enter of their own; ← and → walk what the right pane
 * walks; F fills the screen with a picture.
 */
function useKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        useUI.setState((s) => ({ palette: !s.palette }));
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName ?? '') || !!active?.isContentEditable;
      if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
      const r = parseRoute(location.hash);
      const { palette, ask } = useUI.getState();
      if (r.view === 'task' && !palette && !ask && e.key === 'Tab') {
        const t = queryClient.getQueryData<Index>(['index'])?.tasks.find((x) => x.id === r.id);
        if (!t) return;
        e.preventDefault();
        const d = queryClient.getQueryData<TaskDetail>(['task', r.id]);
        const report = !!d?.files.some((f) => f.path === 'report.html');
        const to = nextStop(taskStops(t, report, !!d && listResources(t, d).length > 0), r, e.shiftKey);
        active?.blur();
        if (to) location.hash = to;
        return;
      }
      const { prev, next } = useUI.getState().keyNav;
      if (e.key === 'ArrowLeft' && prev) {
        e.preventDefault();
        location.hash = prev;
      } else if (e.key === 'ArrowRight' && next) {
        e.preventDefault();
        location.hash = next;
      } else if (e.key === 'f' || e.key === 'F') {
        const stage = document.querySelector<HTMLElement>('.right .stage');
        if (stage?.querySelector('img.shot')) {
          if (document.fullscreenElement) void document.exitFullscreen();
          else void stage.requestFullscreen?.();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const left = useUI((s) => s.prefs.left);
  const index = useIndex();
  useEffect(() => connect(), []);
  useEffect(() => {
    if (index.isError) useUI.setState({ connected: false });
  }, [index.isError]);
  useRouteEffects();
  useAgentFollow();
  useKeys();
  return (
    <>
      <div className={'app' + (left ? '' : ' left-hidden')} id="app">
        <Left />
        <Middle />
        <Right />
        <button type="button" className="rail-open" id="rail-open" aria-label="Show the task list" title="Show the task list" onClick={() => setPref('left', true)}>
          <Icon name="panel" size={17} />
        </button>
      </div>
      <Toast />
      <AskModal />
      <Palette />
    </>
  );
}
