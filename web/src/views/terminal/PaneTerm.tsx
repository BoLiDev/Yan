import { useState, type RefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { MOD } from '../../lib/format';
import type { Tile } from '../../lib/tiles';
import { cn } from '../../lib/utils';
import { Button } from '../../components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '../../components/ui/context-menu';
import { toast } from '../../state/ui';
import { XTERM } from './look';
import { usePaneTerm, type Panes } from './usePaneTerm';

const at = (n: number): string => `${n * 100}%`;

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
export function PaneTerm({ task, tile, agent, panes: shared, split, paste, close }: {
  task: string;
  tile: Tile;
  agent: boolean;
  panes: RefObject<Panes>;
  split: (direction: 'right' | 'down') => void;
  paste: (text: string) => void;
  close: () => void;
}) {
  const { pane } = tile;
  const { host, ended, reconnect } = usePaneTerm({ task, pane, agent, shared });
  // What is selected in the pane as its menu opens: Copy copies it, and is not offered without it.
  const [selected, setSelected] = useState('');
  const term = (): Terminal | undefined => shared.current.terms.get(pane);
  return (
    <ContextMenu onOpenChange={(open) => {
      const t = term();
      if (open) setSelected(t?.hasSelection() === true ? t.getSelection() : '');
    }}>
      {/* A right click on a pane opens its own menu in place of the browser's. A line parts it from a pane above it
          or to its left. Named for what runs in it, it is a pane to a screen reader. */}
      <ContextMenuTrigger render={
        <div role="group" aria-roledescription="pane" aria-label={agent ? 'Agent' : 'Shell'}
          className={cn('absolute overflow-hidden bg-[var(--term-bg)] px-2.5 py-2', (tile.left || tile.top) && 'border-[var(--term-line)]', tile.left && 'border-l', tile.top && 'border-t')}
          style={{ left: at(tile.x), top: at(tile.y), width: at(tile.w), height: at(tile.h) }} />
      }>
        {/* data-term: where a key is typed into a terminal, which takes Ctrl chords as its own (App's paletteKey). */}
        <div className={cn('inline-block align-top', XTERM)} ref={host} data-term="" />
        {/* The note is near white over the dark pane whatever the page is, so its ink is the terminal's dark: the
            page's own ink turns light with a dark page, and would not show on it. */}
        {ended !== null ? (
          <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-[10px] bg-[var(--term-note)] px-3.5 py-2.5 text-[13px] text-[color:var(--term-bg)]">
            <span className="min-w-0 flex-auto wrap-anywhere">{`The screen was cut off: ${ended}`}</span>
            <Button variant="secondary" onClick={reconnect}>Reconnect</Button>
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
