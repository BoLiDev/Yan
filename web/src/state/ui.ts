import { create } from 'zustand';
import type { Status } from '../lib/api';
import type { Seen } from '../lib/seen';

/**
 * What the page holds of its own, apart from what the server sends (which
 * is in server.ts): the reader's preferences and what they have seen, kept
 * in this browser, and how each part of the page was left, for this visit.
 */

export interface Prefs {
  /** The task list shown. */
  readonly left: boolean;
  /** A dark backdrop behind pictures. */
  readonly dark: boolean;
  readonly layout: 'unified' | 'split';
  /** The width a page is drawn at. */
  readonly width: 'fit' | '1280' | '390';
  /** A diff shows the whole file around its changes. */
  readonly whole: boolean;
  /** Per extension, whether long lines wrap, where the reader said. */
  readonly wrap: Readonly<Record<string, boolean>>;
  /** Chrome says when a push arrives. */
  readonly notify: boolean;
}

export interface Ask {
  readonly title: string;
  readonly sub?: string;
  readonly action: string;
  /** Also asks for a line, which the button waits for. */
  readonly reason?: string;
  readonly then: (given: string) => void;
}

/** Last words said on a task's report, so a redraw for the commit they caused keeps them a moment. */
export interface Said {
  readonly text: string;
  readonly bad: boolean;
  readonly at: number;
}

interface UI {
  prefs: Prefs;
  /** Null until the first index, which a first visit starts its marks from. */
  seen: Seen | null;
  connected: boolean;
  pulling: boolean;
  status: Status | null;
  /** The find box's text. */
  query: string;
  /** `<task>:<repo>` → whether the nav lists its branches, as last asked; folded until then. */
  unfolded: Readonly<Record<string, boolean>>;
  /** A task's artifacts folders that are open, or a branch's files folders; unset until first shown. */
  open: Readonly<Record<string, readonly string[]>>;
  /** A branch's changes folders closed by hand; every other one is open. */
  closed: Readonly<Record<string, readonly string[]>>;
  /** Latest's pushes opened to their files, `<task>@<time>`. */
  feedOpen: readonly string[];
  /** Where each task was last left, so its row in the task list goes back there. */
  last: Readonly<Record<string, string>>;
  /** problem.md's sha as the visit to a task began, for the tint of what is new since. */
  problemBase: Readonly<Record<string, string | null>>;
  /** How many log entries had been read as the visit to a task began. */
  logBase: Readonly<Record<string, number>>;
  /** A page or a Markdown file shown as its source. */
  pageSource: boolean;
  mdSource: boolean;
  /** Where ← and → go from what the right pane shows. */
  keyNav: { readonly prev: string | null; readonly next: string | null };
  toast: { readonly text: string; readonly n: number } | null;
  ask: Ask | null;
  said: Readonly<Record<string, Said>>;
}

const PREFS_KEY = 'yan.serve.prefs';
const SEEN_KEY = 'yan.serve.seen';

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // a private window keeps nothing, and the page works without it
  }
}

const DEFAULT_PREFS: Prefs = { left: true, dark: false, layout: 'unified', width: 'fit', whole: false, wrap: {}, notify: false };

/** What this browser kept of the marks, read once: the first index decides what a first visit starts from. */
export const storedSeen: unknown = load(SEEN_KEY, null);

export const useUI = create<UI>(() => ({
  prefs: { ...DEFAULT_PREFS, ...load<Partial<Prefs>>(PREFS_KEY, {}) },
  seen: null,
  connected: true,
  pulling: false,
  status: null,
  query: '',
  unfolded: {},
  open: {},
  closed: {},
  feedOpen: [],
  last: {},
  problemBase: {},
  logBase: {},
  pageSource: false,
  mdSource: false,
  keyNav: { prev: null, next: null },
  toast: null,
  ask: null,
  said: {},
}));

useUI.subscribe((s, before) => {
  if (s.prefs !== before.prefs) save(PREFS_KEY, s.prefs);
  if (s.seen !== before.seen && s.seen) save(SEEN_KEY, s.seen);
});

export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  useUI.setState((s) => ({ prefs: { ...s.prefs, [key]: value } }));
}

/** Change the marks, when there are any yet; `change` returns null for no change. */
export function setSeen(change: (seen: Seen) => Seen | null): boolean {
  const { seen } = useUI.getState();
  if (!seen) return false;
  const next = change(seen);
  if (!next || next === seen) return false;
  useUI.setState({ seen: next });
  return true;
}

export function toast(text: string): void {
  useUI.setState((s) => ({ toast: { text, n: (s.toast?.n ?? 0) + 1 } }));
}

export function ask(question: Ask): void {
  useUI.setState({ ask: question });
}

/** Put `text` on the clipboard and say `said`; where the browser will not, show it to be copied by hand. */
export function copyText(text: string, said: string, what: string): void {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast(said), () => prompt(what, text));
  else prompt(what, text);
}

/** A set kept as a list in the store, with `path` in it or not. */
export function toggled(list: readonly string[] | undefined, path: string, on: boolean): string[] {
  const set = new Set(list ?? []);
  if (on) set.add(path);
  else set.delete(path);
  return [...set];
}
