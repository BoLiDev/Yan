import { useEffect, useRef, useState, type RefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { postJSON, type TerminalState } from '../lib/api';
import { MOD } from '../lib/format';
import { keyFor } from '../lib/keys';
import { usePageKeys } from '../lib/modal';
import { tilesOf, type Tile } from '../lib/tiles';
import { cn } from '../lib/utils';
import { Icon } from '../components/Icon';
import { Bar, Empty } from '../components/ui';
import { Button } from '../components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../components/ui/context-menu';
import { queryClient } from '../state/server';
import { useTheme } from '../state/theme';
import { toast } from '../state/ui';
import { useKeyNav } from './nav';

/**
 * The terminal's face, as a terminal set up for yan's page has it: 0xProto (its Nerd Font build when installed) for
 * Latin, ChillRound (寒蝉圆体) for Chinese, which 0xProto has none of; the page's own faces, so installed copies
 * come first and yan's copies after.
 */
const MONO = '"Yan Code", "Yan Round", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** A terminal's colours, the theme's: dark whatever the page is, a shade darker when the page is. */
function termTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string): string => css.getPropertyValue(name).trim();
  return { background: v('--term-bg'), foreground: v('--term-fg'), cursor: v('--term-fg'), selectionBackground: v('--term-selection') };
}

type Input = { keys: string[] } | { text: string } | { paste: string; enter: boolean } | { wheel: number; col: number; row: number } | { cols: number; rows: number };

let sending: Promise<void> = Promise.resolve();

/**
 * What is typed, sent to a pane of the agent's tab: keys by herdr's names,
 * bytes as a terminal sends them, or a paste. One after another, each once
 * the one before is in, so a Backspace never overtakes the letter it takes
 * back.
 */
function send(task: string, pane: string, what: Input): void {
  sending = sending.then(() => postJSON('/api/terminal/input', { task, pane, ...what }).then(() => undefined, (err: Error) => toast(`Not sent: ${err.message}`, true)));
}

/** A pane split off, or closed, through herdr; the tab as herdr then has it is asked for at once. */
async function reshape(what: 'split' | 'close', body: Record<string, unknown>): Promise<{ pane?: string } | undefined> {
  const failed = what === 'split' ? 'Could not split the pane' : 'Could not close the pane';
  try {
    return await postJSON<{ pane?: string }>(`/api/terminal/${what}`, body);
  } catch (err) {
    toast(`${failed}: ${(err as Error).message}`, true);
    return undefined;
  } finally {
    void queryClient.invalidateQueries({ queryKey: ['terminals'] });
  }
}

/** What the tab's panes share: each one's terminal, the one typed in last, and one split off to be typed in next. */
interface Panes {
  readonly terms: Map<string, Terminal>;
  last: string | undefined;
  next: string | undefined;
}

/**
 * The agent's tab, as herdr streams its panes: the bytes each program
 * draws, drawn by xterm.js, so what is here is what is in the terminal,
 * the agent's questions, menus and completions with it. The tab is split
 * as herdr has it, the agent and any shell split off beside it, in herdr or
 * here: a right click on a pane splits it, copies, pastes, or closes a shell.
 */
export function TerminalView({ id, state, waiting = false, goesOn = false }: { id: string; state: TerminalState | undefined; waiting?: boolean; goesOn?: boolean }) {
  useKeyNav(null, null);
  // Gone on with from here, the task's terminal is the dark stage until herdr lists the new tab's pane.
  const [starting, setStarting] = useState(false);
  // Listed, it is no longer starting: put so as it is drawn, not after, so a stop later shows Continue again.
  if (state && starting) setStarting(false);
  // The panes' terminals, read in effects and handlers only: none of it is drawn.
  const panes = useRef<Panes>({ terms: new Map(), last: undefined, next: undefined });

  // Enter on the page, nothing else taking it, puts the keys in the terminal typed in last, as a click on it does.
  usePageKeys((e) => {
    const active = document.activeElement;
    if (e.key !== 'Enter' || /^(BUTTON|A)$/.test(active?.tagName ?? '')) return false;
    const p = panes.current;
    const term = p.terms.get(p.last ?? '') ?? p.terms.get(state?.pane ?? '');
    term?.focus();
    return term !== undefined;
  });

  // A new task's tab, opened a moment ago, is a dark terminal until herdr lists its pane.
  if (!state && (waiting || starting)) return <><Bar title="Terminal" meta="" /><div className="term-tiles" /></>;
  if (!state) {
    const goOn = async (): Promise<void> => {
      setStarting(true);
      try {
        await postJSON('/api/launch', { task: id });
      } catch (err) {
        setStarting(false);
        return void toast(`Could not continue: ${(err as Error).message}`, true);
      }
      void queryClient.invalidateQueries({ queryKey: ['terminals'] });
    };
    return (
      <>
        {/* Continue is where Stop is while one runs: the bar's own way to start or stop it. */}
        <Bar title="Terminal" meta="" tools={goesOn ? <Button className="self-center" onClick={() => void goOn()}>Continue</Button> : null} />
        {/* A terminal, large, and nothing to read. */}
        <div className="term-off">
          <Icon name="terminal" size={256} width={0.4} />
        </div>
      </>
    );
  }
  const tiles = tilesOf(state.layout ?? { pane: state.pane });
  return (
    <>
      {/* What the agent is doing is the Terminal row's to say, and the terminal's own: the bar holds only Stop. */}
      <Bar title="Terminal" meta="" tools={waiting ? null : <StopButton id={id} />} />
      {state.streams ? (
        <div className="term-tiles">
          {tiles.map((tile) => (
            <PaneTerm key={tile.pane} task={id} tile={tile} agent={tile.pane === state.pane} panes={panes}
              split={(direction) => void reshape('split', { task: id, pane: tile.pane, direction }).then((made) => {
                panes.current.next = made?.pane;
              })}
              paste={(text) => send(id, tile.pane, { paste: text, enter: false })}
              close={() => void reshape('close', { task: id, pane: tile.pane })} />
          ))}
        </div>
      ) : (
        <Empty title="herdr is too old">{`herdr on this machine is ${state.herdr || 'a version it does not say'}; showing its panes here takes 0.7.2 or newer (the latest stable is best). Run herdr update.`}</Empty>
      )}
    </>
  );
}

/**
 * The task's agent stopped: its herdr tab closed, the shells beside it with
 * it. Asked twice, the first click only turning it to Really stop, which goes
 * back after a few seconds untouched.
 */
function StopButton({ id }: { id: string }) {
  const [sure, setSure] = useState(false);
  useEffect(() => {
    if (!sure) return;
    const back = window.setTimeout(() => setSure(false), 3000);
    return () => window.clearTimeout(back);
  }, [sure]);
  const stop = async (): Promise<void> => {
    setSure(false);
    try {
      await postJSON('/api/terminal/stop', { task: id });
    } catch (err) {
      return void toast(`Could not stop: ${(err as Error).message}`, true);
    }
    void queryClient.invalidateQueries({ queryKey: ['terminals'] });
  };
  return (
    <Button variant={sure ? 'default' : 'ghost'} className={cn('self-center', sure ? 'bg-destructive text-white hover:bg-destructive/90' : 'text-destructive hover:bg-destructive/10 hover:text-destructive')}
      onClick={() => (sure ? void stop() : setSure(true))}>{sure ? 'Really stop' : 'Stop'}</Button>
  );
}

/**
 * One pane of the tab, where herdr's split puts it, sized to that room as a
 * terminal window sizes it, so its program fills it and draws itself anew
 * as the room changes; the page holds the pane so only while it is seen,
 * and herdr's own window has it back the moment it is not.
 * What is typed in it goes to the pane as typed; a key herdr has a name for
 * goes by the name, so herdr encodes it as the program asked. It is the only
 * place to type: the agent's own input takes a message of many lines, a
 * paste and an IME's text as a terminal's does.
 */
function PaneTerm({ task, tile, agent, panes: shared, split, paste, close }: {
  task: string;
  tile: Tile;
  agent: boolean;
  panes: RefObject<Panes>;
  split: (direction: 'right' | 'down') => void;
  paste: (text: string) => void;
  close: () => void;
}) {
  const { pane } = tile;
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

    // Bytes typed in a burst go together, so a word is one request and not one a letter; a key sent by name sends them first.
    let typed = '';
    let flush: number | undefined;
    const sendTyped = (): void => {
      window.clearTimeout(flush);
      flush = undefined;
      if (typed !== '') send(task, pane, { text: typed });
      typed = '';
    };
    term.onData((data) => {
      typed += data;
      flush ??= window.setTimeout(sendTyped, 12);
    });
    term.attachCustomKeyEventHandler((e) => {
      const key = keyFor(e);
      if (key === 'browser') return false;
      if (key === 'typed') return true;
      // Ctrl+C with something selected copies it, as off a Mac it would anywhere else.
      if (key === 'ctrl+c' && term.hasSelection()) {
        if (e.type === 'keydown') void navigator.clipboard?.writeText(term.getSelection());
        return false;
      }
      if (e.type === 'keydown') {
        e.preventDefault();
        sendTyped();
        send(task, pane, { keys: [key] });
      }
      return false;
    });
    // The wheel, anywhere over the pane, goes to it, a row for each row's height turned, as the server routes it;
    // never to xterm.js, which with nothing of its own to scroll would send ↑ and ↓ instead, the agent's history keys.
    term.attachCustomWheelEventHandler(() => false);
    let turned = 0;
    let wheeling: number | undefined;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const screen = el.querySelector<HTMLElement>('.xterm-screen');
      if (!screen || term.rows === 0) return;
      const box = screen.getBoundingClientRect();
      const cell = { w: box.width / term.cols, h: box.height / term.rows };
      turned += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? e.deltaY * term.rows : e.deltaY / cell.h;
      const col = Math.min(term.cols, Math.max(1, Math.floor((e.clientX - box.left) / cell.w) + 1));
      const row = Math.min(term.rows, Math.max(1, Math.floor((e.clientY - box.top) / cell.h) + 1));
      wheeling ??= window.setTimeout(() => {
        wheeling = undefined;
        const rows = Math.trunc(turned);
        turned -= rows;
        if (rows !== 0) {
          sendTyped();
          send(task, pane, { wheel: rows, col, row });
        }
      }, 40);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    // A paste goes as one, so the agent takes it as pasted and does not act on each line of it.
    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      e.preventDefault();
      e.stopPropagation();
      if (text !== '') send(task, pane, { paste: text, enter: false });
    };
    el.addEventListener('paste', onPaste, true);
    const onFocus = (): void => {
      panes.last = pane;
    };

    let source: EventSource | undefined;
    // A frame is herdr's picture at the size it was made for: a full one draws it all, any other only what changed
    // since the last. One made for a size the pane no longer has, on its way while the pane was sized anew (as
    // when DevTools' edge is dragged), laid on the new size would leave stale lines behind it. So the terminal takes
    // its size from the frames alone; after asking for a size, frames are let pass until herdr's full one for it comes,
    // which it sends after every resize, asked for again if it is slow; and a full one clears the screen first.
    let asked: { cols: number; rows: number } | undefined;
    let waitingSince: number | undefined;
    const ask = (size: { cols: number; rows: number }): void => {
      asked = size;
      waitingSince = Date.now();
      send(task, pane, size);
    };
    const draw = (frame: { width: number; height: number; full: boolean; bytes: string }): void => {
      if (!frame.full) {
        const stale = frame.width !== term.cols || frame.height !== term.rows;
        if (waitingSince === undefined && !stale) return term.write(Uint8Array.from(atob(frame.bytes), (c) => c.charCodeAt(0)));
        if (waitingSince === undefined || Date.now() - waitingSince > 2000) ask(fits() ?? asked ?? { cols: term.cols, rows: term.rows });
        return;
      }
      waitingSince = undefined;
      if (frame.width > 0 && frame.height > 0 && (frame.width !== term.cols || frame.height !== term.rows)) term.resize(frame.width, frame.height);
      term.write('\x1b[H\x1b[2J');
      term.write(Uint8Array.from(atob(frame.bytes), (c) => c.charCodeAt(0)));
    };
    // A shell's stream ending is most often its pane closed, which the tab, asked again, no longer has; only one still
    // there after that says it is cut off. The agent's says so at once.
    let ending: number | undefined;
    const end = (why: string): void => {
      if (agent) return setEnded(why);
      void queryClient.invalidateQueries({ queryKey: ['terminals'] });
      ending = window.setTimeout(() => setEnded(why), 2500);
    };
    const connect = (): void => {
      const size = fits();
      if (disposed || source !== undefined || size === undefined || document.visibilityState === 'hidden') return;
      asked = size;
      waitingSince = Date.now();
      const s = new EventSource(`/api/terminal/stream?task=${encodeURIComponent(task)}&pane=${encodeURIComponent(pane)}&cols=${size.cols}&rows=${size.rows}`);
      source = s;
      s.onmessage = (m) => draw(JSON.parse(m.data as string) as { width: number; height: number; full: boolean; bytes: string });
      s.addEventListener('closed', (m) => {
        s.close();
        if (source === s) source = undefined;
        end((JSON.parse((m as MessageEvent).data as string) as { why: string }).why);
      });
      s.onerror = () => {
        if (s.readyState !== EventSource.CLOSED) return;
        if (source === s) source = undefined;
        end('herdr\'s screen cannot be reached');
      };
    };
    // Unseen, the page lets the pane go back to herdr's own size; seen again, it takes it at its room's.
    const onShown = (): void => {
      if (document.visibilityState === 'hidden') {
        source?.close();
        source = undefined;
      } else connect();
    };
    document.addEventListener('visibilitychange', onShown);

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
      connect();
    });

    // The room changing, as DevTools opening beside it or a pane split off, sizes the pane anew once it has stopped
    // changing, not at each step of a drag: every size is a redraw of the program's own, and Claude Code on the normal
    // screen leaves a line of its old bottom behind at each, as in any terminal dragged. Then herdr is asked for one
    // more full redraw at that size, so nothing of the page's outlasts the drag.
    let settling: number | undefined;
    let settled: number | undefined;
    const sized = new ResizeObserver(() => {
      window.clearTimeout(settling);
      window.clearTimeout(settled);
      settling = window.setTimeout(() => {
        const size = fits();
        if (size === undefined || source === undefined || (size.cols === asked?.cols && size.rows === asked.rows)) return;
        ask(size);
        settled = window.setTimeout(() => {
          if (source !== undefined && asked !== undefined) ask(asked);
        }, 600);
      }, 350);
    });
    sized.observe(stage);

    return () => {
      disposed = true;
      if (panes.terms.get(pane) === term) panes.terms.delete(pane);
      if (panes.last === pane) panes.last = undefined;
      source?.close();
      sized.disconnect();
      document.removeEventListener('visibilitychange', onShown);
      window.clearTimeout(settling);
      window.clearTimeout(settled);
      window.clearTimeout(ending);
      el.removeEventListener('paste', onPaste, true);
      stage.removeEventListener('wheel', onWheel);
      term.textarea?.removeEventListener('focus', onFocus);
      window.clearTimeout(flush);
      window.clearTimeout(wheeling);
      term.dispose();
    };
  }, [task, pane, agent, shared, attempt]);

  // The theme changing recolours the pane where it stands.
  const theme = useTheme();
  useEffect(() => {
    const t = shared.current.terms.get(pane);
    if (t) t.options.theme = termTheme();
  }, [theme, shared, pane]);

  const at = (n: number): string => `${n * 100}%`;
  // What is selected in the pane as its menu opens: Copy copies it, and is not offered without it.
  const [selected, setSelected] = useState('');
  const term = (): Terminal | undefined => shared.current.terms.get(pane);
  return (
    <ContextMenu onOpenChange={(open) => {
      const t = term();
      if (open) setSelected(t?.hasSelection() === true ? t.getSelection() : '');
    }}>
      {/* A right click on a pane opens its own menu in place of the browser's. */}
      <ContextMenuTrigger render={<div className={'term-stage' + (tile.left ? ' left' : '') + (tile.top ? ' top' : '')} style={{ left: at(tile.x), top: at(tile.y), width: at(tile.w), height: at(tile.h) }} />}>
        <div className="term" ref={host} />
        {ended !== null ? (
          <div className="term-ended">
            <span>{`The screen was cut off: ${ended}`}</span>
            <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)}>Reconnect</Button>
          </div>
        ) : null}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-40">
        <ContextMenuItem onClick={() => split('right')}>Split right</ContextMenuItem>
        <ContextMenuItem onClick={() => split('down')}>Split down</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={selected === ''} onClick={() => {
          void navigator.clipboard?.writeText(selected);
          term()?.focus();
        }}>Copy</ContextMenuItem>
        <ContextMenuItem onClick={() => {
          term()?.focus();
          // Reading the clipboard is the browser's to allow; refused, the keys still paste.
          void navigator.clipboard?.readText().then((text) => {
            if (text !== '') paste(text);
          }, () => toast(`The browser did not allow reading the clipboard: paste with ${MOD}V`));
        }}>Paste</ContextMenuItem>
        {/* The agent's own pane is never closed from here: that would end the agent. */}
        {agent ? null : (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onClick={close}>Close</ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
