import { Terminal } from '@xterm/xterm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reset, serve } from '../../testing/serve';
import { follow } from './stream';

/** herdr's stream of a pane, as the page's EventSource has it: each frame handed to the page as herdr sends it. */
class Stream {
  static last: Stream | undefined;
  readyState = 1;
  onmessage: ((m: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    Stream.last = this;
  }
  addEventListener(): void {}
  close(): void {
    this.readyState = 2;
  }
  send(frame: { width: number; height: number; full: boolean; bytes: string }): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }));
  }
}

/** A full frame as herdr draws one: every row addressed and filled out to the pane's width, Claude Code's footer at the bottom. */
function screen(width: number, height: number): string[] {
  return Array.from({ length: height }, (_, r) =>
    r === height - 2 ? '─'.repeat(width) : r === height - 1 ? '  ⏵⏵ bypass permissions on' : `line ${r + 1}`);
}
function full(width: number, height: number): { width: number; height: number; full: boolean; bytes: string } {
  const rows = screen(width, height).map((text, r) => `\x1b[${r + 1};1H${text.padEnd(width, ' ')}`).join('');
  const bytes = new TextEncoder().encode(`\x1b[?2026h${rows}\x1b[0m\x1b[${height - 2};3H\x1b[?2026l`);
  return { width, height, full: true, bytes: btoa(String.fromCharCode(...bytes)) };
}

describe('a pane followed as herdr streams it', () => {
  afterEach(async () => {
    await reset();
    document.body.replaceChildren();
  });

  it('shows herdr\'s screen in order after the pane is narrowed and then made taller', async () => {
    serve({ 'POST /api/terminal/input': Response.json({ ok: true }) });
    vi.stubGlobal('EventSource', Stream);
    const stage = document.body.appendChild(document.createElement('div'));
    const term = new Terminal({ cols: 60, rows: 8, scrollback: 0 });
    term.open(stage.appendChild(document.createElement('div')));
    const followed = follow(term, { task: 't1', pane: 'p1', agent: true, stage, fits: () => ({ cols: 60, rows: 8 }), ended: () => undefined });
    followed.connect();

    // As when a shell is split off to its right, and then one below it is closed: each frame drawn before the next
    // comes, as herdr's come apart.
    for (const [w, h] of [[60, 8], [50, 8], [50, 10]] as const) {
      Stream.last?.send(full(w, h));
      await new Promise<void>((done) => term.write('', done));
    }
    // However its view is scrolled, as it settles while the room changes: there is nothing above the screen to show.
    term.scrollToTop();

    const view = term.buffer.active;
    const shown = Array.from({ length: term.rows }, (_, r) => view.getLine(view.viewportY + r)?.translateToString(true).trimEnd() ?? '');
    expect(shown).toEqual(screen(50, 10));
    followed.dispose();
    term.dispose();
  });
});
