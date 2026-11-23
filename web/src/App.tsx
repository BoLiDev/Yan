import { useEffect, useEffectEvent, useRef } from 'react';
import { JANUS, works, type Index, type TaskDetail } from './lib/api';
import { foldersAbove } from './lib/files';
import { usePageKeys } from './lib/modal';
import { composing, pageChord } from './lib/keys';
import { fullPageOf, link, parseRoute, useHash, useRoute, type Route } from './lib/route';
import { listResources } from './lib/resources';
import { goesOn, nextStop, taskStops } from './lib/stops';
import { Palette } from './components/Palette';
import { DraftsModal } from './components/drafts/DraftsModal';
import { NewTaskModal } from './components/NewTask';
import { SettingsModal } from './components/Settings';
import { TaskActModal } from './components/TaskMenu';
import { ArtifactActModal } from './components/ArtifactMenu';
import { Review } from './components/review/ReviewLazy';
import { AskModal, Messages } from './components/page';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { AGENT_TOASTER, useAgentToasts } from './state/agentToasts';
import { Left } from './panes/Left';
import { Middle } from './panes/Middle';
import { Right, lookAt } from './panes/Right';
import { FullPage } from './views/FullPage';
import { followAgent, noAgent, useAgentTab } from './state/agentTab';
import { connect, queryClient, useIndex, useTask } from './state/server';
import { useUI } from './state/ui';

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
    // A new task is asked for in a box over the page: #/new alone opens it, over whatever task the page goes to.
    if (r.view === 'new' && r.launch === undefined) {
      useUI.setState({ newTask: true });
      location.replace(link.none());
      return;
    }
    // At no task, the page goes to one: the last read here, else the one worked on last. There is nothing else to land on.
    if (r.view === 'none' && index && fullPageOf(hash) === null) {
      const { recent } = useUI.getState();
      const open = works(index.tasks).filter(goesOn).sort((a, b) => b.touched - a.touched);
      const to = recent.find((id) => index.tasks.some((t) => t.id === id)) ?? open[0]?.id ?? works(index.tasks)[0]?.id;
      if (to !== undefined) {
        location.replace(useUI.getState().last[to] ?? link.task(to));
        return;
      }
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
function useKeys(): void {
  // The page's own chords work anywhere, in a field, over a box and in a terminal: Ctrl+F opens the box to find a task,
  // and closes it, in place of the browser's own find, which has little to look through here; Ctrl+D the drafts
  // likewise; and Ctrl+J goes to Janus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const chord = composing(e) ? undefined : pageChord(e);
      if (chord === undefined) return;
      e.preventDefault();
      if (chord === 'palette') useUI.setState((s) => ({ palette: !s.palette }));
      else if (chord === 'drafts') useUI.setState((s) => ({ drafts: !s.drafts }));
      else location.hash = link.terminal(JANUS);
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
      const has = { report, resources: !!d && listResources(t, d).length > 0, terminal: terminal || goesOn(t) };
      const to = nextStop(taskStops(t, has), r, e.shiftKey);
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
  const index = useIndex();
  useEffect(() => connect(), []);
  useEffect(() => {
    if (index.isError) useUI.setState({ connected: false });
  }, [index.isError]);
  useRouteEffects();
  useAgentFollow();
  useAgentToasts();
  useKeys();
  // A page an agent wrote, given the window: nothing of the task list or the task is drawn round it.
  const full = fullPageOf(useHash());
  return (
    <TooltipProvider delay={400}>
      {full ? <div className="h-screen w-screen bg-card" id="app"><FullPage task={full.id} path={full.path} /></div> : (
        <div className="flex h-screen" id="app">
          <Left />
          <Middle />
          <Right />
        </div>
      )}
      <Toaster position="bottom-center" />
      <Toaster id={AGENT_TOASTER} position="top-right" />
      <Messages />
      <AskModal />
      <Palette />
      <NewTaskModal />
      <DraftsModal />
      <TaskActModal />
      <ArtifactActModal />
      <SettingsModal />
      <Review />
    </TooltipProvider>
  );
}
