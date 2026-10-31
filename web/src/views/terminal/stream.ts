import type { Terminal } from '@xterm/xterm';
import { queryClient } from '../../state/server';
import { send } from './transport';

type Size = { cols: number; rows: number };
type Frame = { width: number; height: number; full: boolean; bytes: string };

const bytesOf = (frame: Frame): Uint8Array => Uint8Array.from(atob(frame.bytes), (c) => c.charCodeAt(0));

/**
 * A pane followed as herdr streams it, drawn into `term` at the size its
 * room on the `stage` holds (`fits`, undefined until a cell is measured),
 * and sized anew as that room changes; `ended` is told why, once the stream
 * is cut off. `connect` starts it, and starts it again when the page is
 * seen again; `dispose` lets the pane go.
 */
export function follow(term: Terminal, { task, pane, agent, stage, fits, ended }: {
  task: string;
  pane: string;
  agent: boolean;
  stage: HTMLElement;
  fits: () => Size | undefined;
  ended: (why: string) => void;
}): { connect: () => void; dispose: () => void } {
  let disposed = false;
  let source: EventSource | undefined;
  // A frame is herdr's picture at the size it was made for: a full one draws it all, any other only what changed
  // since the last. One made for a size the pane no longer has, on its way while the pane was sized anew (as
  // when DevTools' edge is dragged), laid on the new size would leave stale lines behind it. So the terminal takes
  // its size from the frames alone; after asking for a size, frames are let pass until herdr's full one for it comes,
  // which it sends after every resize, asked for again if it is slow; and a full one clears the screen first.
  let asked: Size | undefined;
  let waitingSince: number | undefined;
  const ask = (size: Size): void => {
    asked = size;
    waitingSince = Date.now();
    send(task, pane, size);
  };
  const draw = (frame: Frame): void => {
    if (!frame.full) {
      const stale = frame.width !== term.cols || frame.height !== term.rows;
      if (waitingSince === undefined && !stale) return term.write(bytesOf(frame));
      if (waitingSince === undefined || Date.now() - waitingSince > 2000) ask(fits() ?? asked ?? { cols: term.cols, rows: term.rows });
      return;
    }
    waitingSince = undefined;
    if (frame.width > 0 && frame.height > 0 && (frame.width !== term.cols || frame.height !== term.rows)) term.resize(frame.width, frame.height);
    term.write('\x1b[H\x1b[2J');
    term.write(bytesOf(frame));
  };
  // A shell's stream ending is most often its pane closed, which the tab, asked again, no longer has; only one still
  // there after that says it is cut off. The agent's says so at once.
  let ending: number | undefined;
  const end = (why: string): void => {
    if (agent) return ended(why);
    void queryClient.invalidateQueries({ queryKey: ['terminals'] });
    ending = window.setTimeout(() => ended(why), 2500);
  };
  const connect = (): void => {
    const size = fits();
    if (disposed || source !== undefined || size === undefined || document.visibilityState === 'hidden') return;
    asked = size;
    waitingSince = Date.now();
    const s = new EventSource(`/api/terminal/stream?task=${encodeURIComponent(task)}&pane=${encodeURIComponent(pane)}&cols=${size.cols}&rows=${size.rows}`);
    source = s;
    s.onmessage = (m) => draw(JSON.parse(m.data as string) as Frame);
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

  return {
    connect,
    dispose: () => {
      disposed = true;
      source?.close();
      sized.disconnect();
      document.removeEventListener('visibilitychange', onShown);
      window.clearTimeout(settling);
      window.clearTimeout(settled);
      window.clearTimeout(ending);
    },
  };
}
