import type { ReactNode } from 'react';
import { Bar } from '../../components/page';

/**
 * The agent's tab, each pane where herdr's split puts it, a line where one
 * meets another, sized to the column, which it fills to the bottom of the
 * page. The light lines that edge the page's columns, the bar's foot and the
 * task list's side, would frame the dark tab, so it is drawn over the one
 * (a pixel to the left) and the bar above it is `flush`.
 */
export function Tiles({ children }: { children?: ReactNode }) {
  return <div className="relative -ml-px min-h-0 flex-auto bg-[var(--term-bg)]">{children}</div>;
}

/**
 * The terminal before it has a pane to draw: its bar over the dark stage it
 * will draw on, while xterm.js loads or until herdr lists a new tab's pane.
 * Light, so the page can draw it before the terminal's own script is in.
 */
export function Waiting() {
  return <><Bar title="Terminal" meta="" flush /><Tiles /></>;
}
