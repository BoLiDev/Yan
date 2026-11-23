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

/**
 * Whether a key is an input method's own, pressed while it composes: the
 * Enter that takes what it offers, or the Escape that drops it, is not the
 * page's to act on. The browser says so on the key, but not every one does
 * in time: Safari ends the composition first and then gives the Enter that
 * ended it, no longer composing, with only its key code, 229, to say an
 * input method took it.
 */
export const composing = (e: { readonly isComposing?: boolean; readonly keyCode?: number }): boolean => e.isComposing === true || e.keyCode === 229;

const NAMED: Readonly<Record<string, string>> = {
  Enter: 'enter', Escape: 'esc', Tab: 'tab', Backspace: 'backspace',
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

/**
 * The page's own Ctrl chords, which work anywhere on it, a terminal
 * included, and are Ctrl on a Mac too: Ctrl+K opens the box to go to a
 * task, Ctrl+D the drafts, Ctrl+J goes to Janus. A terminal gives them up,
 * though there Ctrl+K cuts the rest of a line, Ctrl+D ends a program's
 * input and Ctrl+J is a new line, since a terminal is where the page is mostly typed in; with Shift
 * held the chord is the terminal's again, sent as it would be without.
 */
export function pageChord(e: Pressed): 'palette' | 'drafts' | 'janus' | undefined {
  if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return undefined;
  const key = e.key.toLowerCase();
  return key === 'k' ? 'palette' : key === 'd' ? 'drafts' : key === 'j' ? 'janus' : undefined;
}

/**
 * What a key pressed in the terminal is: one herdr names, sent as a name so
 * herdr encodes it as the program in the pane asked (Shift+Tab, Shift+Enter
 * and Ctrl+C among them); `browser`, a ⌘ chord or one of the page's own,
 * left to the page (⌘C, ⌘V, Ctrl+K, Ctrl+D, Ctrl+J); or `typed`, for xterm.js to turn into the bytes a terminal sends,
 * letters, IME text, Home, Delete and the like. Every key an IME is
 * composing with is `typed`, so the Enter that commits English letters
 * typed in a Chinese IME commits them rather than sending the message.
 */
export function keyFor(e: Pressed): string | 'browser' | 'typed' {
  if (composing(e)) return 'typed';
  if (e.metaKey || pageChord(e) !== undefined) return 'browser';
  const mods = `${e.ctrlKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}`;
  const named = NAMED[e.key];
  if (named !== undefined) return mods + named;
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return mods + e.key.toLowerCase();
  if (e.ctrlKey && !e.altKey && /^[a-z]$/i.test(e.key)) return `ctrl+${e.key.toLowerCase()}`;
  return 'typed';
}
