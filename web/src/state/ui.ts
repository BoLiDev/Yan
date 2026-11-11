import { toast as sonner } from 'sonner';
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
  /** The page's own theme: the browser's, or light or dark whatever the browser says. */
  readonly theme: 'system' | 'light' | 'dark';
  readonly layout: 'unified' | 'split';
  /** The width a page is drawn at. */
  readonly width: 'fit' | '1280' | '390';
  /** A diff shows the whole file around its changes. */
  readonly whole: boolean;
  /** Per extension, whether long lines wrap, where the reader said. */
  readonly wrap: Readonly<Record<string, boolean>>;
  /** Chrome says when a push arrives. */
  readonly notify: boolean;
  /**
   * A branch's files are all of them, rather than its source code alone by
   * the vault's rules, which they are until switched. Kept under a name of
   * its own, so a browser that kept the switch off while it started off
   * starts with source code alone too.
   */
  readonly allFiles: boolean;
}

export interface Ask {
  readonly title: string;
  readonly sub?: string;
  readonly action: string;
  /** Also asks for a line, which the button waits for. */
  readonly reason?: string;
  readonly then: (given: string) => void;
}

/** What a task's menu asked for: a new title, the task paused, or its agent to close it as done or given up. */
export interface TaskAct {
  readonly kind: 'rename' | 'pause' | 'done' | 'abandon';
  readonly id: string;
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
  /** ⌘K's box is open. */
  palette: boolean;
  /** The new task's box is open. */
  newTask: boolean;
  /** The drafts' box is open. */
  drafts: boolean;
  /** A draft whose saving failed after its box was left, kept to be shown again, being written, in place of losing it. */
  draftKept: KeptDraft | null;
  /** What each new task started from this page was given, by its launch, for the page to show while it is made. */
  launched: Readonly<Record<string, Launched>>;
  /** The tasks visited, the last first, kept in this browser: what ⌘K offers before anything is typed. */
  recent: readonly string[];
  /** A task's artifacts folders that are open, or a branch's files folders; unset until first shown. */
  open: Readonly<Record<string, readonly string[]>>;
  /** A branch's changes folders closed by hand; every other one is open. */
  closed: Readonly<Record<string, readonly string[]>>;
  /** The months of done tasks unfolded in the task list; every other one is folded. */
  months: readonly string[];
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
  /** The version of the Markdown file open whose changes are shown in place of it, by its commit; another file opens as itself. */
  mdVersion: string | null;
  /** What to select in a Markdown file's source as it next opens, by the file's path in the vault: the lines, counted from 0, and in them the words, when they are written as they read. */
  mdSelect: { readonly key: string; readonly from: number; readonly to: number; readonly quote: string } | null;
  /** A Markdown artifact's source edited and not saved, by its path in the vault, with the file it began from: kept while the page is open. */
  edits: Readonly<Record<string, { readonly sha: string; readonly text: string }>>;
  /**
   * A Markdown artifact's source as it was saved from the page, by its path
   * in the vault, with the file it was saved over: shown as the file, in
   * Source and Rendered alike, until the page has fetched the commit it made.
   */
  saved: Readonly<Record<string, { readonly sha: string; readonly text: string }>>;
  /** Where ← and → go from what the right pane shows. */
  keyNav: { readonly prev: string | null; readonly next: string | null };
  ask: Ask | null;
  /** The tab a task's terminal shows, by task: its agent's, `agent`, unless one of its worktree tabs, by its id, was asked for. */
  termTab: Readonly<Record<string, string>>;
  /** The box a task's menu opened over the page: renaming it, or having its agent close it. */
  taskAct: TaskAct | null;
  said: Readonly<Record<string, Said>>;
}

/** A draft written on the page and not saved: which it is, null for a new one, the sha it was begun from, and what was written. */
export interface KeptDraft {
  readonly id: string | null;
  readonly sha: string;
  readonly text: string;
}

/** A new task as the page asked for it: its title, and each repository with the packages it is about, `[]` for all. */
export interface Launched {
  readonly title: string;
  readonly repos: readonly { readonly name: string; readonly scope: readonly string[] }[];
}

const PREFS_KEY = 'yan.serve.prefs';
const SEEN_KEY = 'yan.serve.seen';
const RECENT_KEY = 'yan.serve.recent';

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

const DEFAULT_PREFS: Prefs = { left: true, dark: false, theme: 'system', layout: 'unified', width: 'fit', whole: false, wrap: {}, notify: false, allFiles: false };

/** What this browser kept of the marks, read once: the first index decides what a first visit starts from. */
export const storedSeen: unknown = load(SEEN_KEY, null);

export const useUI = create<UI>(() => ({
  prefs: { ...DEFAULT_PREFS, ...load<Partial<Prefs>>(PREFS_KEY, {}) },
  seen: null,
  connected: true,
  pulling: false,
  status: null,
  palette: false,
  newTask: false,
  drafts: false,
  draftKept: null,
  launched: {},
  recent: load<string[]>(RECENT_KEY, []),
  open: {},
  closed: {},
  months: [],
  feedOpen: [],
  last: {},
  problemBase: {},
  logBase: {},
  pageSource: false,
  mdSource: false,
  mdVersion: null,
  mdSelect: null,
  edits: {},
  saved: {},
  keyNav: { prev: null, next: null },
  ask: null,
  termTab: {},
  taskAct: null,
  said: {},
}));

useUI.subscribe((s, before) => {
  if (s.prefs !== before.prefs) save(PREFS_KEY, s.prefs);
  if (s.seen !== before.seen && s.seen) save(SEEN_KEY, s.seen);
  if (s.recent !== before.recent) save(RECENT_KEY, s.recent);
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

/**
 * A toast at the foot of the page: what needs reading, and may need
 * something done about it, a change that did not go through above all, said
 * with why (`bad`). What only confirms what was just done is a `message`.
 */
export function toast(text: string, bad = false): void {
  if (bad) sonner.error(text);
  else sonner(text);
}

export function ask(question: Ask): void {
  useUI.setState({ ask: question });
}

/** The toaster at the top of the page that says what was just done, `Messages`. */
export const MESSAGES = 'messages';

/**
 * A word on what was just done, in the small pill at the top of the page
 * (`Messages`), gone in a moment, as a phone or a web framework says it:
 * `success` that it went through, `info` what came of it, `warning` why it
 * was not done, a field left blank, say, in a line. What needs reading, an
 * error with its reason, or anything said to `user` unasked, an agent's
 * words, is a `toast`.
 */
export const message = {
  success: (text: string): void => void sonner.success(text, { toasterId: MESSAGES, duration: 1600 }),
  info: (text: string): void => void sonner.info(text, { toasterId: MESSAGES, duration: 2200 }),
  warning: (text: string): void => void sonner.warning(text, { toasterId: MESSAGES, duration: 3000 }),
};

/** Put `text` on the clipboard and say `said` at the top of the page; where the browser will not, show it to be copied by hand. */
export function copyText(text: string, said: string, what: string): void {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => message.success(said), () => prompt(what, text));
  else prompt(what, text);
}

/** A set kept as a list in the store, with `path` in it or not. */
export function toggled(list: readonly string[] | undefined, path: string, on: boolean): string[] {
  const set = new Set(list ?? []);
  if (on) set.add(path);
  else set.delete(path);
  return [...set];
}
