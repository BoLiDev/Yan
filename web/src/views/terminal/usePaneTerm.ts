import { useEffect, useRef, useState, type RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useTheme } from '../../state/theme';
import { takePaste, takeTyping, takeWheel } from './input';
import { MONO, termTheme } from './look';
import { follow } from './stream';

/** What the tab's panes share: each one's terminal, the one typed in last, and one split off to be typed in next. */
export interface Panes {
  readonly terms: Map<string, Terminal>;
  last: string | undefined;
  next: string | undefined;
}

/**
 * The terminal of `pane`, drawn by xterm.js in the element `host` is put
 * on, whose parent is the pane's room on the page, and kept in `shared`
 * while it is drawn: what is typed, wheeled and pasted in it goes to the
 * pane, and what herdr streams of the pane is drawn in it. `ended` says why
 * the stream was cut off, and `reconnect` follows the pane afresh.
 */
export function usePaneTerm({ task, pane, agent, shared }: {
  task: string;
  pane: string;
  agent: boolean;
  shared: RefObject<Panes>;
}): { host: RefObject<HTMLDivElement | null>; ended: string | null; reconnect: () => void } {
  const host = useRef<HTMLDivElement>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const panes = shared.current;
    setEnded(null);
    let disposed = false;
    const term = new Terminal({
      fontFamily: MONO, fontSize: 13, lineHeight: 1.15, cursorBlink: false, scrollback: 0, rightClickSelectsWord: false,
      theme: termTheme(),
    });
    const stage = el.parentElement as HTMLElement;
    // As many cells as the pane's room holds, a cell as xterm.js draws one; nothing around the terminal scrolls, so
    // nothing moves under the program's own screen.
    let cell: { w: number; h: number } | undefined;
    const fits = (): { cols: number; rows: number } | undefined => {
      if (cell === undefined) return undefined;
      const style = getComputedStyle(stage);
      const w = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const h = stage.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      return { cols: Math.max(20, Math.floor(w / cell.w)), rows: Math.max(5, Math.floor(h / cell.h)) };
    };

    const typing = takeTyping(term, task, pane);
    const unwheel = takeWheel(stage, el, term, task, pane, typing.sendTyped);
    const unpaste = takePaste(el, task, pane);
    const onFocus = (): void => {
      panes.last = pane;
    };
    const followed = follow(term, { task, pane, agent, stage, fits, ended: setEnded });

    // Both faces loaded before xterm.js measures its cells, the Chinese one by a character it is needed for.
    void Promise.all([document.fonts.load('13px "Yan Code"'), document.fonts.load('13px "Yan Round"', '中')]).finally(() => {
      if (disposed) return;
      term.open(el);
      panes.terms.set(pane, term);
      term.textarea?.addEventListener('focus', onFocus);
      // A shell just split off from here is where the next keys go.
      if (panes.next === pane) {
        panes.next = undefined;
        term.focus();
      }
      const screen = el.querySelector<HTMLElement>('.xterm-screen');
      if (screen && screen.clientWidth > 0) cell = { w: screen.clientWidth / term.cols, h: screen.clientHeight / term.rows };
      followed.connect();
    });

    return () => {
      disposed = true;
      if (panes.terms.get(pane) === term) panes.terms.delete(pane);
      if (panes.last === pane) panes.last = undefined;
      followed.dispose();
      unpaste();
      unwheel();
      term.textarea?.removeEventListener('focus', onFocus);
      typing.dispose();
      term.dispose();
    };
  }, [task, pane, agent, shared, attempt]);

  // The theme changing recolours the pane where it stands.
  const theme = useTheme();
  useEffect(() => {
    const t = shared.current.terms.get(pane);
    if (t) t.options.theme = termTheme();
  }, [theme, shared, pane]);

  return { host, ended, reconnect: () => setAttempt((n) => n + 1) };
}
