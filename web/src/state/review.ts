import { create } from 'zustand';
import type { ReviewComment } from '../lib/api';

/**
 * A review as it is gathered: what `user` says of a task's files and
 * branches, a comment at a time as they read, until they are through and it
 * is written to the vault whole. A long read is not done in one sitting, so
 * what is gathered is kept in this browser, a reload or a day between, and
 * let go of only once serve has it.
 */

/** A comment not yet in a review: where the page was when it was made, to go back to, and the text it marks there. */
export interface Kept extends ReviewComment {
  readonly id: string;
  /** The page's address as the comment was made. */
  readonly href: string;
  /** What was selected as the document holds it, text nodes end to end: what it is found again by, to be marked. */
  readonly exact: string;
}

/** A comment being written: all of one but its words. */
export type Drafted = Omit<Kept, 'id' | 'text'> & { readonly task: string };

/** A review written to the vault from this page, until its box is closed. */
export interface Written {
  readonly path: string;
  readonly comments: number;
}

interface ReviewState {
  /** By task. */
  comments: Readonly<Record<string, readonly Kept[]>>;
  /** The word on it all, by task, as far as it is written. */
  summary: Readonly<Record<string, string>>;
  drafting: Drafted | null;
  /** The task whose review is open in its box, or null. */
  open: string | null;
  written: Readonly<Record<string, Written>>;
}

const KEY = 'yan.serve.review';

function load(): Pick<ReviewState, 'comments' | 'summary'> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ReviewState> | null;
    return { comments: v?.comments ?? {}, summary: v?.summary ?? {} };
  } catch {
    return { comments: {}, summary: {} };
  }
}

export const useReview = create<ReviewState>(() => ({ ...load(), drafting: null, open: null, written: {} }));

useReview.subscribe((s, before) => {
  if (s.comments === before.comments && s.summary === before.summary) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ comments: s.comments, summary: s.summary }));
  } catch {
    // a private window keeps nothing, and the review lasts as long as the page does
  }
});

const NONE: readonly Kept[] = [];

/** The comments gathered on a task, in the order they were made. */
export const useComments = (task: string | undefined): readonly Kept[] => useReview((s) => (task === undefined ? NONE : s.comments[task] ?? NONE));

const changed = (task: string, change: (list: readonly Kept[]) => readonly Kept[]): void =>
  useReview.setState((s) => ({ comments: { ...s.comments, [task]: change(s.comments[task] ?? []) } }));

/** Keep what was being written as a comment, with its words; how many the task's review holds now. */
export function addComment(d: Drafted, text: string): number {
  const { task, ...rest } = d;
  changed(task, (list) => [...list, { ...rest, text, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}` }]);
  return (useReview.getState().comments[task] ?? []).length;
}

export const rewordComment = (task: string, id: string, text: string): void => changed(task, (list) => list.map((c) => (c.id === id ? { ...c, text } : c)));

export const dropComment = (task: string, id: string): void => changed(task, (list) => list.filter((c) => c.id !== id));

export const setSummary = (task: string, text: string): void => useReview.setState((s) => ({ summary: { ...s.summary, [task]: text } }));

/** The task's review is in the vault: nothing of it is kept here but where it went. */
export function reviewWritten(task: string, written: Written): void {
  useReview.setState((s) => {
    const { [task]: _c, ...comments } = s.comments;
    const { [task]: _s, ...summary } = s.summary;
    return { comments, summary, written: { ...s.written, [task]: written } };
  });
}
