import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TerminalState } from '../lib/api';
import { MOD } from '../lib/format';
import { keyFor } from '../lib/keys';
import { tilesOf, type Tile } from '../lib/tiles';
import { Icon } from '../components/Icon';
import { Bar, Empty } from '../components/ui';
import { queryClient } from '../state/server';
import { toast } from '../state/ui';
import { useKeyNav } from './nav';

/**
 * The terminal's face, as a terminal set up for yan's page has it: 0xProto (its Nerd Font build when installed) for
 * Latin, ChillRound (寒蝉圆体) for Chinese, which 0xProto has none of; the page's own faces, so installed copies
 * come first and yan's copies after.
 */
const MONO = '"Yan Code", "Yan Round", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

type Input = { keys: string[] } | { text: string } | { paste: string; enter: boolean } | { wheel: number; col: number; row: number } | { cols: number; rows: number };

let sending: Promise<void> = Promise.resolve();

/**
 * What is typed, sent to a pane of the agent's tab: keys by herdr's names,
 * bytes as a terminal sends them, or a paste. One after another, each once
 * the one before is in, so a Backspace never overtakes the letter it takes
 * back.
 */
function send(task: string, pane: string, what: Input): void {
  sending = sending.then(() => fetch('/api/terminal/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, pane, ...what }) })
    .then(async (r) => {
      if (!r.ok) toast(`没发出去：${(await r.text()) || r.status}`);
    }, (err: Error) => toast(`没发出去：${err.message}`)));
}

/** A pane split off, or closed, through herdr; the tab as herdr then has it is asked for at once. */
async function reshape(what: 'split' | 'close', body: Record<string, unknown>): Promise<{ pane?: string } | undefined> {
  const failed = what === 'split' ? '没分出来' : '没关掉';
  try {
    const r = await fetch(`/api/terminal/${what}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) return void toast(`${failed}：${(await r.text()) || r.status}`);
    return (await r.json()) as { pane?: string };
  } catch (err) {
    toast(`${failed}：${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  } finally {
    void queryClient.invalidateQueries({ queryKey: ['terminals'] });
  }
}

/** What the tab's panes share: each one's terminal, the one typed in last, one split off to be typed in next, and the menu. */
interface Panes {
  readonly terms: Map<string, Terminal>;
  last: string | undefined;
  next: string | undefined;
  menu: (at: { x: number; y: number }, pane: string) => void;
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
  useEffect(() => {
    if (state) setStarting(false);
  }, [state]);
  const [menu, setMenu] = useState<{ x: number; y: number; pane: string } | null>(null);
  const panes = useRef<Panes>({ terms: new Map(), last: undefined, next: undefined, menu: () => undefined }).current;
  panes.menu = (at, pane) => setMenu({ ...at, pane });

  // Enter on the page, nothing else taking it, puts the keys in the terminal typed in last, as a click on it does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement as HTMLElement | null;
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(active?.tagName ?? '')) return;
      e.preventDefault();
      (panes.terms.get(panes.last ?? '') ?? panes.terms.get(state?.pane ?? ''))?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [panes, state?.pane]);

  // A new task's tab, opened a moment ago, is a dark terminal until herdr lists its pane.
  if (!state && (waiting || starting)) return <><Bar title="Terminal" meta="" /><div className="term-tiles" /></>;
  if (!state) {
    const goOn = async (): Promise<void> => {
      setStarting(true);
      const r = await fetch('/api/launch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: id }) }).catch((err: Error) => err);
      if (r instanceof Error || !r.ok) {
        setStarting(false);
        return void toast(`没能继续：${r instanceof Error ? r.message : (await r.text()) || r.status}`);
      }
      void queryClient.invalidateQueries({ queryKey: ['terminals'] });
    };
    return (
      <>
        <Bar title="Terminal" meta="" />
        {/* A terminal, large, and the way to start it again: nothing to read. */}
        <div className="term-off">
          <Icon name="terminal" size={168} width={0.6} />
          {goesOn ? <button type="button" className="button" onClick={() => void goOn()}>继续</button> : null}
        </div>
      </>
    );
  }
  const tiles = tilesOf(state.layout ?? { pane: state.pane });
  return (
    <>
      {/* What the agent is doing is the Terminal row's to say, and the terminal's own: the bar holds only 结束. */}
      <Bar title="Terminal" meta="" tools={waiting ? null : <StopButton id={id} />} />
      {state.streams ? (
        <div className="term-tiles">
          {tiles.map((tile) => <PaneTerm key={tile.pane} task={id} tile={tile} agent={tile.pane === state.pane} panes={panes} />)}
          {menu !== null ? (
            <PaneMenu at={menu} agent={menu.pane === state.pane} term={panes.terms.get(menu.pane)} onClose={() => setMenu(null)}
              split={(direction) => void reshape('split', { task: id, pane: menu.pane, direction }).then((made) => {
                panes.next = made?.pane;
              })}
              paste={(text) => send(id, menu.pane, { paste: text, enter: false })}
              close={() => void reshape('close', { task: id, pane: menu.pane })} />
          ) : null}
        </div>
      ) : (
        <Empty title="herdr 版本太旧">{`这台机器上的 herdr 是 ${state.herdr || '未知版本'}，在网页里显示 pane 需要 0.7.2 或更新的版本（推荐最新的稳定版）。运行 herdr update 升级。`}</Empty>
      )}
    </>
  );
}

/**
 * The task's agent stopped: its herdr tab closed, the shells beside it with
 * it. Asked twice, the first click only turning it to 确认结束, which goes
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
    const r = await fetch('/api/terminal/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: id }) }).catch((err: Error) => err);
    if (r instanceof Error || !r.ok) return void toast(`没能结束：${r instanceof Error ? r.message : (await r.text()) || r.status}`);
    void queryClient.invalidateQueries({ queryKey: ['terminals'] });
  };
  return <button type="button" className={'term-stop' + (sure ? ' sure' : '')} onClick={() => (sure ? void stop() : setSure(true))}>{sure ? '确认结束' : '结束'}</button>;
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
function PaneTerm({ task, tile, agent, panes }: { task: string; tile: Tile; agent: boolean; panes: Panes }) {
  const { pane } = tile;
  const host = useRef<HTMLDivElement>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setEnded(null);
    let disposed = false;
    const term = new Terminal({
      fontFamily: MONO, fontSize: 13, lineHeight: 1.15, cursorBlink: false, scrollback: 0, rightClickSelectsWord: false,
      theme: { background: '#1b1b19', foreground: '#e3e1d9', cursor: '#e3e1d9', selectionBackground: '#4a4a44' },
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
        end('连不上 herdr 的画面');
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
  }, [task, pane, agent, panes, attempt]);

  const at = (n: number): string => `${n * 100}%`;
  return (
    <div className={'term-stage' + (tile.left ? ' left' : '') + (tile.top ? ' top' : '')} style={{ left: at(tile.x), top: at(tile.y), width: at(tile.w), height: at(tile.h) }}
      onContextMenu={(e) => {
        e.preventDefault();
        panes.menu({ x: e.clientX, y: e.clientY }, pane);
      }}>
      <div className="term" ref={host} />
      {ended !== null ? (
        <div className="term-ended">
          <span>{`画面断开了：${ended}`}</span>
          <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>重新连接</button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A pane's own menu, where it was right-clicked, in place of the browser's:
 * split it beside or below, copy what is selected in it, paste into it, and
 * close it, when it is not the agent's own. Gone at a click elsewhere, Esc,
 * the wheel, or the window losing focus.
 */
function PaneMenu({ at, agent, term, onClose, split, paste, close }: {
  at: { x: number; y: number };
  agent: boolean;
  term: Terminal | undefined;
  onClose: () => void;
  split: (direction: 'right' | 'down') => void;
  paste: (text: string) => void;
  close: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState(at);
  // Kept inside the window, as a menu near its edge opens the other way.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    setPlace({ x: Math.max(8, Math.min(at.x, window.innerWidth - el.offsetWidth - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - el.offsetHeight - 8)) });
  }, [at.x, at.y]);
  useEffect(() => {
    const away = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) onClose();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', key, true);
    document.addEventListener('wheel', onClose, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', away, true);
      document.removeEventListener('keydown', key, true);
      document.removeEventListener('wheel', onClose, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const selected = term?.hasSelection() === true ? term.getSelection() : '';
  const act = (then: () => void) => () => {
    onClose();
    then();
  };
  return (
    <div ref={box} className="term-menu" role="menu" style={{ left: place.x, top: place.y }}>
      <button type="button" role="menuitem" onClick={act(() => split('right'))}>向右分屏</button>
      <button type="button" role="menuitem" onClick={act(() => split('down'))}>向下分屏</button>
      <hr />
      <button type="button" role="menuitem" disabled={selected === ''} onClick={act(() => {
        void navigator.clipboard?.writeText(selected);
        term?.focus();
      })}>复制</button>
      <button type="button" role="menuitem" onClick={act(() => {
        term?.focus();
        // Reading the clipboard is the browser's to allow; refused, the keys still paste.
        void navigator.clipboard?.readText().then((text) => {
          if (text !== '') paste(text);
        }, () => toast(`浏览器没有允许读取剪贴板，可以用 ${MOD}V 粘贴`));
      })}>粘贴</button>
      {agent ? null : (
        <>
          <hr />
          <button type="button" role="menuitem" className="red" onClick={act(close)}>关闭</button>
        </>
      )}
    </div>
  );
}
