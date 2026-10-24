import { useEffect, useRef } from 'react';
import type { TaskDetail } from './lib/api';
import { foldersAbove, kindOf } from './lib/files';
import { useHash, useRoute, type Route } from './lib/route';
import { Icon } from './components/Icon';
import { AskModal, Toast } from './components/ui';
import { Left, findBox } from './panes/Left';
import { Middle } from './panes/Middle';
import { Right, lookAt } from './panes/Right';
import { connect, useIndex, useTask } from './state/server';
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
    // The log marks itself read as it opens, after noting where the visit started.
    if (index && !(r.view === 'task' && r.sub === 'log')) lookAt(r, index);
    // Only when the route moves, or once the index first arrives.
  }, [hash, !!index]);

  // A file asked for opens the folders above it, and shows past a filter that hides its kind.
  const id = r.view === 'task' && (r.sub === 'file' || r.sub === 'folder') ? r.id : undefined;
  const { data: d } = useTask(id);
  useEffect(() => {
    if (!d || r.view !== 'task' || (r.sub !== 'file' && r.sub !== 'folder')) return;
    openTo(d, r.sub === 'file' ? foldersAbove(r.path) : [r.path, ...foldersAbove(r.path)]);
    if (r.sub === 'file') {
      const f = useUI.getState().filter[r.id];
      if (f && f !== 'all' && kindOf(r.path) !== f) useUI.setState((s) => ({ filter: { ...s.filter, [r.id]: 'all' } }));
    }
  }, [hash, !!d]);
}

function openTo(d: TaskDetail, folders: readonly string[]): void {
  const want = folders.filter(Boolean);
  if (!want.length) return;
  useUI.setState((s) => {
    const kept = s.open[d.id] ?? (d.files.length > 40 ? [] : [...new Set(d.files.flatMap((f) => foldersAbove(f.path)))]);
    return { open: { ...s.open, [d.id]: [...new Set([...kept, ...want])] } };
  });
}

/** ⌘K finds a task; ← and → walk what the right pane walks; F fills the screen with a picture. */
function useKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (!useUI.getState().prefs.left) setPref('left', true);
        requestAnimationFrame(() => {
          findBox.current?.focus();
          findBox.current?.select();
        });
        return;
      }
      const active = document.activeElement as HTMLElement | null;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(active?.tagName ?? '') || !!active?.isContentEditable;
      if (typing || e.altKey || e.ctrlKey || e.metaKey) return;
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
    </>
  );
}
