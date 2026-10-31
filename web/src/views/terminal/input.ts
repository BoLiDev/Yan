import type { Terminal } from '@xterm/xterm';
import { keyFor } from '../../lib/keys';
import { send } from './transport';

/**
 * What is typed in a pane, sent to it as typed; a key herdr has a name for
 * goes by the name, so herdr encodes it as the program asked. Bytes typed in
 * a burst go together, so a word is one request and not one a letter; a key
 * sent by name sends them first, and so does `sendTyped`.
 */
export function takeTyping(term: Terminal, task: string, pane: string): { sendTyped: () => void; dispose: () => void } {
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

/** A paste goes as one, so the agent takes it as pasted and does not act on each line of it. */
export function takePaste(el: HTMLElement, task: string, pane: string): () => void {
  const onPaste = (e: ClipboardEvent): void => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    e.preventDefault();
    e.stopPropagation();
    if (text !== '') send(task, pane, { paste: text, enter: false });
  };
  el.addEventListener('paste', onPaste, true);
  return () => el.removeEventListener('paste', onPaste, true);
}
