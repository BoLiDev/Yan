// Keys typed into an agent's terminal on the page, as herdr is to send them.

/** A key as the browser says it: KeyboardEvent's fields that matter here. */
export interface Pressed {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  /** While an IME composes, its keys are its own: Enter commits what is typed, as letters if need be. */
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

const NAMED: Readonly<Record<string, string>> = {
  Enter: 'enter', Escape: 'esc', Tab: 'tab', Backspace: 'backspace',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

/**
 * What a key pressed in the terminal is: one herdr names, sent as a name so
 * herdr encodes it as the program in the pane asked (Shift+Tab, Shift+Enter
 * and Ctrl+C among them); `browser`, a ⌘ chord, left to the page (⌘K, ⌘C,
 * ⌘V); or `typed`, for xterm.js to turn into the bytes a terminal sends,
 * letters, IME text, Home, Delete and the like. Every key an IME is
 * composing with is `typed`, so the Enter that commits English letters
 * typed in a Chinese IME commits them rather than sending the message.
 */
export function keyFor(e: Pressed): string | 'browser' | 'typed' {
  // 229 is a key an IME took, as Safari says it.
  if (e.isComposing === true || e.keyCode === 229) return 'typed';
  if (e.metaKey) return 'browser';
  const mods = `${e.ctrlKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}`;
  const named = NAMED[e.key];
  if (named !== undefined) return mods + named;
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return mods + e.key.toLowerCase();
  if (e.ctrlKey && !e.altKey && /^[a-z]$/i.test(e.key)) return `ctrl+${e.key.toLowerCase()}`;
  return 'typed';
}
