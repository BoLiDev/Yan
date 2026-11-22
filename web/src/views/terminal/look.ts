/**
 * The terminal's face, as a terminal set up for yan's page has it: 0xProto (its Nerd Font build when installed) for
 * Latin, ChillRound (寒蝉圆体) for Chinese, which 0xProto has none of; the page's own faces, so installed copies
 * come first and yan's copies after. Written as the settings show it, a list a reader adds to or changes.
 */
export const MONO = 'Yan Code, Yan Round, ui-monospace, SF Mono, Menlo, Consolas, monospace';

/** A terminal's colours, the theme's: dark whatever the page is, a shade darker when the page is. */
export function termTheme(): { background: string; foreground: string; cursor: string; selectionBackground: string } {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string): string => css.getPropertyValue(name).trim();
  return { background: v('--term-bg'), foreground: v('--term-fg'), cursor: v('--term-fg'), selectionBackground: v('--term-selection') };
}

/**
 * What xterm.js draws a pane with, set from the element it draws in, since
 * what it adds has no element of ours to put a class on. Its stylesheet is in
 * no layer, so it outranks every utility that is not !important.
 */
export const XTERM = [
  // The viewport has nothing to scroll and nothing of its own to show: the pane's screen is drawn whole, on the stage's dark.
  '[&_.xterm-viewport]:overflow-y-hidden!',
  '[&_.xterm-viewport]:bg-transparent!',
  // xterm.js's own scrollbar has nothing to scroll, the pane being drawn whole, and would stick out below it.
  '[&_.xterm_.scrollbar]:hidden!',
  // What an input method is composing is drawn by xterm.js over the cursor, on one line however long: it wraps, and is
  // as wide as its words up to the room it is given (the box xterm.js keeps it in has no width to fill), and
  // as tall as it then is, so words dictated at length stay in the pane (`takeComposing` gives it the room it has).
  '[&_.composition-view]:h-auto! [&_.composition-view]:w-max [&_.composition-view]:overflow-y-auto [&_.composition-view]:whitespace-pre-wrap! [&_.composition-view]:wrap-anywhere',
].join(' ');
