import type { Terminal } from '@xterm/xterm';
import { MOD } from '../../lib/format';
import { keyFor } from '../../lib/keys';
import { send } from './transport';

/**
 * What is typed in a pane, sent to it as typed; a key herdr has a name for
 * goes by the name, so herdr encodes it as the program asked. What is typed
 * in a burst goes together, in the order it was typed: letters as one run
 * of bytes, keys one after another as one list, so a word is one request
 * and not one a letter, and so is a run of Backspaces. A tool that takes
 * dictation sends hundreds of those at once to take back what it typed
 * before it pastes what was said, and a request for each kept the paste
 * waiting behind them all. `sendTyped` sends what is waiting at once, for
 * what must come after it.
 */
export function takeTyping(term: Terminal, task: string, pane: string): { sendTyped: () => void; dispose: () => void } {
  let waiting: ({ text: string } | { keys: string[] })[] = [];
  let flush: number | undefined;
  const sendTyped = (): void => {
    window.clearTimeout(flush);
    flush = undefined;
    for (const part of waiting) send(task, pane, part);
    waiting = [];
  };
  const later = (): void => {
    flush ??= window.setTimeout(sendTyped, 12);
  };
  term.onData((data) => {
    const last = waiting.at(-1);
    if (last !== undefined && 'text' in last) last.text += data;
    else waiting.push({ text: data });
    later();
  });
  term.attachCustomKeyEventHandler((e) => {
    const key = keyFor(e);
    if (key === 'browser') return false;
    if (key === 'typed') return true;
    // Off a Mac, Ctrl+V is the browser's paste, and is left to it, so what is on the clipboard is taken at once
    // (`takePaste`). Sent on as a key, the program in the pane reads the clipboard for itself, a moment later, and
    // by then it may hold something else: a tool that types by pasting, as one that takes dictation does, puts its
    // words there, pastes, and puts back what was there before.
    if (key === 'ctrl+v' && MOD !== '⌘') return false;
    // Ctrl+C with something selected copies it, as off a Mac it would anywhere else.
    if (key === 'ctrl+c' && term.hasSelection()) {
      if (e.type === 'keydown') void navigator.clipboard?.writeText(term.getSelection());
      return false;
    }
    if (e.type === 'keydown') {
      e.preventDefault();
      const last = waiting.at(-1);
      if (last !== undefined && 'keys' in last) last.keys.push(key);
      else waiting.push({ keys: [key] });
      later();
    }
    return false;
  });
  return { sendTyped, dispose: () => window.clearTimeout(flush) };
}

/**
 * The wheel, anywhere over the pane's `stage`, goes to it, a row for each
 * row's height turned, as the server routes it; never to xterm.js, which with
 * nothing of its own to scroll would send ↑ and ↓ instead, the agent's
 * history keys. What was typed before it goes first.
 */
export function takeWheel(stage: HTMLElement, el: HTMLElement, term: Terminal, task: string, pane: string, sendTyped: () => void): () => void {
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
  return () => {
    stage.removeEventListener('wheel', onWheel);
    window.clearTimeout(wheeling);
  };
}

/**
 * A paste goes as one, so the agent takes it as pasted and does not act on
 * each line of it: the words on the clipboard as the paste was made, not
 * as it is when they get there. A clipboard with no words on it, a picture
 * copied, has nothing to send this way: the program in the pane is given
 * Ctrl+V, which an agent takes to read the clipboard itself, picture and
 * all, the clipboard being this machine's.
 */
export function takePaste(el: HTMLElement, task: string, pane: string, sendTyped: () => void): () => void {
  const onPaste = (e: ClipboardEvent): void => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    e.preventDefault();
    e.stopPropagation();
    // What was typed before it goes first, so the paste lands after it.
    sendTyped();
    if (text !== '') send(task, pane, { paste: text, enter: false });
    else send(task, pane, { keys: ['ctrl+v'] });
  };
  el.addEventListener('paste', onPaste, true);
  return () => el.removeEventListener('paste', onPaste, true);
}
