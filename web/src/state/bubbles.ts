import { create } from 'zustand';

/**
 * What a task's square says, with the task list folded to the rail, when
 * its agent has something to tell `user`: a bubble from the square, as a
 * toast says it with the list shown. What the agent said with `yan say`
 * reaches the page with its push, a few seconds after herdr says the turn
 * ended, so a finish pops the bubble at once, typing, and the words fill it
 * as they come; words that never come leave the page's own.
 */
export interface Bubble {
  /** The task's title, over the words. */
  readonly title: string;
  /** The words: the agent's, or the page's own; null while the agent's are on their way. */
  readonly text: string | null;
  /** What it says when the agent's words have not come by `until`. */
  readonly fallback: string;
  /** When to stop waiting for them, in ms since the epoch. */
  readonly until: number;
  /** Where a click on it goes: the task's terminal, or the task. */
  readonly to: string;
  /** Which saying this is: each anew pops it again, words filling one typing do not. */
  readonly n: number;
}

export const useBubbles = create<{ bubbles: Readonly<Record<string, Bubble>> }>(() => ({ bubbles: {} }));

let said = 0;

/**
 * `task`'s square says something: words filling the bubble that waits for
 * them stay in it, and anything else pops a bubble of its own in place of
 * the one there.
 */
export function popBubble(task: string, b: Omit<Bubble, 'n'>): void {
  useBubbles.setState((s) => {
    const was = s.bubbles[task];
    const n = was !== undefined && was.text === null && b.text !== null ? was.n : ++said;
    return { bubbles: { ...s.bubbles, [task]: { ...b, n } } };
  });
}

/** The words `task`'s bubble waited for did not come: it says its own. */
export function stopWaiting(task: string, n: number): void {
  useBubbles.setState((s) => {
    const was = s.bubbles[task];
    if (was === undefined || was.n !== n || was.text !== null) return s;
    return { bubbles: { ...s.bubbles, [task]: { ...was, text: was.fallback } } };
  });
}

/** `task`'s bubble gone, when it is still the saying `n`, or whichever it is without. */
export function dropBubble(task: string, n?: number): void {
  useBubbles.setState((s) => {
    const was = s.bubbles[task];
    if (was === undefined || (n !== undefined && was.n !== n)) return s;
    const { [task]: _gone, ...rest } = s.bubbles;
    return { bubbles: rest };
  });
}

/** Every bubble gone: the rail is, the task list shown. */
export function dropAllBubbles(): void {
  useBubbles.setState({ bubbles: {} });
}
