import { useEffect, useEffectEvent, useRef } from 'react';
import type { Index, TaskDetail } from './lib/api';
import { foldersAbove } from './lib/files';
import { MOD } from './lib/format';
import { usePageKeys } from './lib/modal';
import { link, parseRoute, useHash, useRoute, type Route } from './lib/route';
import { listResources } from './lib/resources';
import { goesOn, nextStop, taskStops } from './lib/stops';
import { Icon } from './components/Icon';
import { Palette } from './components/Palette';
import { NewTaskModal } from './components/NewTask';
import { AskModal } from './components/page';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { Button } from './components/ui/button';
import { useTheme } from './state/theme';
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
  const hasIndex = index !== undefined;
  // What a move does reads the route and the index as they are, but only a move, or the index first arriving, makes one.
  const moved = useEffectEvent(() => {
    const was = before.current;
    before.current = r;
    useUI.setState({ pageSource: false });
    // A new task is asked for in a box over the page: #/new alone opens it, over Latest.
    if (r.view === 'new' && r.launch === undefined) {
      useUI.setState({ newTask: true });
      location.replace(link.latest());
      return;
    }
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
  });
  useEffect(() => moved(), [hash, hasIndex]);

  // A file asked for opens the folders above it.
  const id = r.view === 'task' && (r.sub === 'file' || r.sub === 'folder') ? r.id : undefined;
  const { data: d } = useTask(id);
  const hasTask = d !== undefined;
  // Opened once as the file is asked for, and not again as the task's files change: what was closed by hand stays closed.
  const reveal = useEffectEvent(() => {
    if (!d || r.view !== 'task' || (r.sub !== 'file' && r.sub !== 'folder')) return;
    openTo(d, r.sub === 'file' ? foldersAbove(r.path) : [r.path, ...foldersAbove(r.path)]);
  });
  useEffect(() => reveal(), [hash, hasTask]);
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
  const hasIndex = index !== undefined;
  useEffect(() => {
    if (id === null || !hasIndex) return;
    const moved = went.current !== id;
    went.current = id;
    if (moved || (first !== undefined && useAgentTab.getState().showing === noAgent(id))) followAgent(first ?? noAgent(id));
  }, [id, first, hasIndex]);
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
/**
 * ⌘K on a Mac and Ctrl+K elsewhere, as the page says it (`MOD`), Shift or
 * not. An agent's terminal takes Ctrl chords as a terminal does (Ctrl+K
 * cuts the rest of a line), so in it Ctrl+K off a Mac is the agent's and
 * Ctrl+Shift+K the palette's; ⌘ chords never reach an agent, so ⌘K is the
 * palette's there too.
 */
function paletteKey(e: KeyboardEvent): boolean {
  if (e.key.toLowerCase() !== 'k' || e.altKey) return false;
  if (MOD === '⌘') return e.metaKey && !e.ctrlKey;
  const inTerminal = e.target instanceof Element && e.target.closest('[data-term]') !== null;
  return e.ctrlKey && !e.metaKey && (e.shiftKey || !inTerminal);
}

function useKeys(): void {
  // ⌘K is the page's one key that works anywhere, in a field and over a box, which it closes when it is ⌘K's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!paletteKey(e)) return;
      e.preventDefault();
      useUI.setState((s) => ({ palette: !s.palette }));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  usePageKeys((e) => {
    const r = parseRoute(location.hash);
    if (r.view === 'task' && e.key === 'Tab') {
      const t = queryClient.getQueryData<Index>(['index'])?.tasks.find((x) => x.id === r.id);
      if (!t) return false;
      const d = queryClient.getQueryData<TaskDetail>(['task', r.id]);
      const report = !!d?.files.some((f) => f.path === 'report.html');
      const terminal = !!queryClient.getQueryData<Record<string, unknown>>(['terminals'])?.[r.id];
      const to = nextStop(taskStops(t, report, !!d && listResources(t, d).length > 0, terminal || goesOn(t)), r, e.shiftKey);
      (document.activeElement as HTMLElement | null)?.blur();
      if (to) location.hash = to;
      return true;
    }
    const { prev, next } = useUI.getState().keyNav;
    if (e.key === 'ArrowLeft' && prev) location.hash = prev;
    else if (e.key === 'ArrowRight' && next) location.hash = next;
    else if (e.key === 'f' || e.key === 'F') {
      const stage = document.querySelector<HTMLElement>('#right [data-stage]');
      if (!stage?.querySelector('img[data-shot]')) return false;
      if (document.fullscreenElement) void document.exitFullscreen();
      else void stage.requestFullscreen?.();
    } else return false;
    return true;
  });
}

export function App() {
  const theme = useTheme();
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
    <TooltipProvider delay={400}>
      <div className="flex h-screen" id="app">
        <Left />
        <Middle />
        <Right />
        {/* With the task list hidden, the way back to it, at the foot of the page's left edge. */}
        {left ? null : (
          <Button variant="secondary" size="icon" className="fixed bottom-2.5 left-2 z-[5] rounded-[9px] text-ink-3 ring-1 ring-border" aria-label="Show the task list" title="Show the task list" onClick={() => setPref('left', true)}>
            <Icon name="panel" size={17} />
          </Button>
        )}
      </div>
      <Toaster position="bottom-center" theme={theme} />
      <AskModal />
      <Palette />
      <NewTaskModal />
    </TooltipProvider>
  );
}
