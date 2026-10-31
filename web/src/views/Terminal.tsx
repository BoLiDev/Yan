import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TaskSummary, TerminalState } from '../lib/api';
import { AGENT_WORD } from '../lib/format';
import { keyFor } from '../lib/keys';
import { Bar, Empty } from '../components/ui';
import { toast } from '../state/ui';
import { useKeyNav } from './nav';

/**
 * The terminal's face, as a terminal set up for yan's page has it: 0xProto (its Nerd Font build when installed) for
 * Latin, ChillRound (寒蝉圆体) for Chinese, which 0xProto has none of; the page's own faces, so installed copies
 * come first and yan's copies after.
 */
const MONO = '"Yan Code", "Yan Round", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

let sending: Promise<void> = Promise.resolve();

/**
 * What is typed, sent to the agent's pane: keys by herdr's names, bytes as a
 * terminal sends them, or a paste. One after another, each once the one
 * before is in, so a Backspace never overtakes the letter it takes back.
 */
function send(task: string, what: { keys: string[] } | { text: string } | { paste: string; enter: boolean } | { wheel: number; col: number; row: number } | { cols: number; rows: number }): void {
  sending = sending.then(() => fetch('/api/terminal/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, ...what }) })
    .then(async (r) => {
      if (!r.ok) toast(`没发出去：${(await r.text()) || r.status}`);
    }, (err: Error) => toast(`没发出去：${err.message}`)));
}

/**
 * The agent's terminal, as herdr streams its pane: the bytes the agent draws,
 * drawn by xterm.js, so what is here is what is in the terminal, its
 * questions, menus and completions with it. The pane is sized to the column,
 * as a terminal window sizes it, so the agent fills it and draws itself anew
 * as the column changes; the page holds the pane so only while it is seen,
 * and herdr's own window has it back the moment it is not.
 * What is typed in it goes to the pane as typed; a key herdr has a name for
 * goes by the name, so herdr encodes it as the agent asked. It is the only
 * place to type: the agent's own input takes a message of many lines, a
 * paste and an IME's text as a terminal's does.
 */
export function TerminalView({ t, state }: { t: TaskSummary; state: TerminalState | undefined }) {
  useKeyNav(null, null);
  const host = useRef<HTMLDivElement>(null);
  const typing = useRef<Terminal | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const streams = state?.streams ?? false;

  useEffect(() => {
    const el = host.current;
    if (!el || !streams) return;
    setEnded(null);
    let disposed = false;
    const term = new Terminal({
      fontFamily: MONO, fontSize: 13, lineHeight: 1.15, cursorBlink: false, scrollback: 0,
      theme: { background: '#1b1b19', foreground: '#e3e1d9', cursor: '#e3e1d9', selectionBackground: '#4a4a44' },
    });
    const stage = el.parentElement as HTMLElement;
    // As many cells as the column holds, a cell as xterm.js draws one; nothing around the terminal scrolls, so nothing
    // moves under the agent's own screen.
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
      if (typed !== '') send(t.id, { text: typed });
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
        send(t.id, { keys: [key] });
      }
      return false;
    });
    // The wheel, anywhere over the stage, goes to the pane, a row for each row's height turned, as the server routes it;
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
          send(t.id, { wheel: rows, col, row });
        }
      }, 40);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    // A paste goes as one, so the agent takes it as pasted and does not act on each line of it.
    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      e.preventDefault();
      e.stopPropagation();
      if (text !== '') send(t.id, { paste: text, enter: false });
    };
    el.addEventListener('paste', onPaste, true);

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
      send(t.id, size);
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
    const connect = (): void => {
      const size = fits();
      if (disposed || source !== undefined || size === undefined || document.visibilityState === 'hidden') return;
      asked = size;
      waitingSince = Date.now();
      const s = new EventSource(`/api/terminal/stream?task=${encodeURIComponent(t.id)}&cols=${size.cols}&rows=${size.rows}`);
      source = s;
      s.onmessage = (m) => draw(JSON.parse(m.data as string) as { width: number; height: number; full: boolean; bytes: string });
      s.addEventListener('closed', (m) => {
        s.close();
        if (source === s) source = undefined;
        setEnded((JSON.parse((m as MessageEvent).data as string) as { why: string }).why);
      });
      s.onerror = () => {
        if (s.readyState !== EventSource.CLOSED) return;
        if (source === s) source = undefined;
        setEnded('连不上 herdr 的画面');
      };
    };
    // Unseen, the page lets the pane go back to herdr's own size; seen again, it takes it at the column's.
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
      typing.current = term;
      const screen = el.querySelector<HTMLElement>('.xterm-screen');
      if (screen && screen.clientWidth > 0) cell = { w: screen.clientWidth / term.cols, h: screen.clientHeight / term.rows };
      connect();
    });

    // The column changing, as DevTools opening beside it, sizes the pane anew once it has stopped changing, not at each
    // step of a drag: every size is a redraw of the agent's own, and Claude Code on the normal screen leaves a line of
    // its old bottom behind at each, as in any terminal dragged. Then herdr is asked for one more full redraw at that
    // size, so nothing of the page's outlasts the drag.
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
      typing.current = null;
      source?.close();
      sized.disconnect();
      document.removeEventListener('visibilitychange', onShown);
      window.clearTimeout(settling);
      window.clearTimeout(settled);
      el.removeEventListener('paste', onPaste, true);
      stage.removeEventListener('wheel', onWheel);
      window.clearTimeout(flush);
      window.clearTimeout(wheeling);
      term.dispose();
    };
  }, [t.id, streams, attempt]);

  // Enter on the page, nothing else taking it, puts the keys in the terminal, as a click on it does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement as HTMLElement | null;
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(active?.tagName ?? '')) return;
      e.preventDefault();
      typing.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!state) return <Empty title="No terminal">{`${t.id}'s agent is not running in a herdr pane on this machine.`}</Empty>;
  const meta = [state.agent ?? `${state.cli}（已退出）`, `herdr ${state.pane}`, AGENT_WORD[state.status]].filter(Boolean).join(' · ');
  return (
    <>
      <Bar title="Terminal" meta={meta} />
      {streams ? (
        <div className="term-stage">
          <div className="term" ref={host} />
          {ended !== null ? (
            <div className="term-ended">
              <span>{`画面断开了：${ended}`}</span>
              <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>重新连接</button>
            </div>
          ) : null}
        </div>
      ) : (
        <Empty title="herdr 版本太旧">{`这台机器上的 herdr 是 ${state.herdr || '未知版本'}，在网页里显示 pane 需要 0.7.2 或更新的版本（推荐最新的稳定版）。运行 herdr update 升级。`}</Empty>
      )}
    </>
  );
}
