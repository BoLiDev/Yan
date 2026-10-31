import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { TaskSummary, TerminalState } from '../lib/api';
import { AGENT_WORD } from '../lib/format';
import { keyFor } from '../lib/keys';
import { Bar, Empty } from '../components/ui';
import { toast } from '../state/ui';
import { useKeyNav } from './nav';

const MONO = '"Yan Code", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

let sending: Promise<void> = Promise.resolve();

/**
 * What is typed, sent to the agent's pane: keys by herdr's names, bytes as a
 * terminal sends them, or a paste. One after another, each once the one
 * before is in, so a Backspace never overtakes the letter it takes back.
 */
function send(task: string, what: { keys: string[] } | { text: string } | { paste: string; enter: boolean }): void {
  sending = sending.then(() => fetch('/api/terminal/input', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task, ...what }) })
    .then(async (r) => {
      if (!r.ok) toast(`没发出去：${(await r.text()) || r.status}`);
    }, (err: Error) => toast(`没发出去：${err.message}`)));
}

/**
 * The agent's terminal, as herdr streams its pane: the bytes the agent draws,
 * drawn by xterm.js at the pane's own size and scaled to fit, so what is here
 * is what is in the terminal, its questions, menus and completions with it.
 * What is typed in it goes to the pane as typed; a key herdr has a name for
 * goes by the name, so herdr encodes it as the agent asked. Below it a box
 * sends a message whole, for one longer than a line or typed with an IME.
 */
export function TerminalView({ t, state }: { t: TaskSummary; state: TerminalState | undefined }) {
  useKeyNav(null, null);
  const host = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState('');
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
    // The pane is drawn its own width in cells; the font is scaled until that width is the column's, as xterm.js measures it.
    const fit = (tries = 3): void => {
      const screen = el.querySelector<HTMLElement>('.xterm-screen');
      const room = (el.parentElement?.clientWidth ?? 0) - 24;
      if (!screen || screen.clientWidth === 0 || room <= 0) return;
      const now = term.options.fontSize ?? 13;
      const size = Math.max(8, Math.min(15, Math.floor(((now * room) / screen.clientWidth) * 10) / 10));
      if (Math.abs(size - now) >= 0.1) {
        term.options.fontSize = size;
        if (tries > 1) requestAnimationFrame(() => fit(tries - 1));
      }
    };
    void document.fonts.load(`13px ${MONO}`).finally(() => {
      if (disposed) return;
      term.open(el);
      fit();
    });

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
    // A paste goes as one, so the agent takes it as pasted and does not act on each line of it.
    const onPaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text/plain') ?? '';
      e.preventDefault();
      e.stopPropagation();
      if (text !== '') send(t.id, { paste: text, enter: false });
    };
    el.addEventListener('paste', onPaste, true);

    const source = new EventSource(`/api/terminal/stream?task=${encodeURIComponent(t.id)}`);
    source.onmessage = (m) => {
      const frame = JSON.parse(m.data as string) as { width: number; height: number; bytes: string };
      if (frame.width > 0 && frame.height > 0 && (frame.width !== term.cols || frame.height !== term.rows)) {
        term.resize(frame.width, frame.height);
        fit();
      }
      term.write(Uint8Array.from(atob(frame.bytes), (c) => c.charCodeAt(0)));
    };
    source.addEventListener('closed', (m) => {
      source.close();
      setEnded((JSON.parse((m as MessageEvent).data as string) as { why: string }).why);
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) setEnded('连不上 herdr 的画面');
    };
    const sized = new ResizeObserver(() => fit());
    sized.observe(el.parentElement ?? el);

    return () => {
      disposed = true;
      source.close();
      sized.disconnect();
      el.removeEventListener('paste', onPaste, true);
      window.clearTimeout(flush);
      term.dispose();
    };
  }, [t.id, streams, attempt]);

  // Enter on the page, nothing else taking it, goes to the box below; Esc in the box gives the keys back to the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const active = document.activeElement as HTMLElement | null;
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(active?.tagName ?? '')) return;
      e.preventDefault();
      box.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const submit = (): void => {
    if (draft.trim() === '') return;
    send(t.id, { paste: draft, enter: true });
    setDraft('');
  };
  const onBoxKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === 'Escape') {
      e.currentTarget.blur();
    }
  };

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
      <div className="term-compose">
        <textarea ref={box} rows={1} value={draft} placeholder={`给 ${state.agent ?? state.cli} 发消息，回车发送，Shift+回车换行`}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={onBoxKey} />
        <button type="button" className="button" disabled={draft.trim() === ''} onClick={submit}>发送<kbd>↵</kbd></button>
      </div>
    </>
  );
}
