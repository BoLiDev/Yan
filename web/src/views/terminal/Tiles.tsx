import type { ReactNode } from 'react';

/**
 * The tab shown, each pane where herdr's split puts it, a line where one
 * meets another, sized to the column, which it fills to the bottom of the
 * page. The light line that edges the task list's side would frame it, so it
 * is drawn over it, a pixel to the left; above it, the tab shown is drawn in
 * its dark, the two one shape.
 */
export function Tiles({ children }: { children?: ReactNode }) {
  return <div className="relative -ml-px min-h-0 flex-auto bg-[var(--term-bg)]">{children}</div>;
}

/**
 * The strip a task's terminal tabs are in, as a browser's: the tabs along
 * its foot, the one shown drawn in the colour of what it shows, and the
 * strip's own tools at its end.
 */
export function Strip({ children }: { children?: ReactNode }) {
  return <div className="flex h-11 flex-none items-end gap-3 bg-[var(--tab-strip)] pr-2.5">{children}</div>;
}

/**
 * The terminal before it has a pane to draw: its strip over the dark stage
 * it will draw on, while xterm.js loads or until herdr lists a new tab's
 * pane. Light, so the page can draw it before the terminal's own script is in.
 */
export function Waiting() {
  return <><Strip /><Tiles /></>;
}
