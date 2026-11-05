import { create } from 'zustand';

/**
 * What a task's square says, with the task list folded to the rail, when
 * its agent has something to tell `user`: a bubble from the square, as a
 * toast says it with the list shown. What the agent said with `yan say`
 * reaches the page with its push, a few seconds after herdr says the turn
 * ended, so a finish pops the bubble at once, typing, and the words fill it
 * as they come; words that never come leave the page's own. A task that
 * speaks again while its bubble is up says it in the same bubble, the new
 * words pushing the old ones out.
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
  /** Where a click on it goes: the task's terminal, its agents elsewhere, or the task. */
  readonly to: string;
  /** Which bubble this is: a bubble popped anew, after the task's last one went, is another. */
  readonly n: number;
  /** Which of its sayings it shows, from 0: each new one rolls into its place. */
  readonly v: number;
}

export const useBubbles = create<{ bubbles: Readonly<Record<string, Bubble>> }>(() => ({ bubbles: {} }));

let popped = 0;

/**
 * `task`'s square says something: in the bubble it has up, rolling in when
 * it says something else, or in one popped for it.
 */
export function popBubble(task: string, b: Omit<Bubble, 'n' | 'v'>): void {
  useBubbles.setState((s) => {
    const was = s.bubbles[task];
    if (was === undefined) return { bubbles: { ...s.bubbles, [task]: { ...b, n: ++popped, v: 0 } } };
    return { bubbles: { ...s.bubbles, [task]: { ...b, n: was.n, v: was.text === b.text ? was.v : was.v + 1 } } };
  });
}

/** The words `task`'s bubble waited for did not come: it says its own. */
export function stopWaiting(task: string, n: number, v: number): void {
  useBubbles.setState((s) => {
    const was = s.bubbles[task];
    if (was === undefined || was.n !== n || was.v !== v || was.text !== null) return s;
    return { bubbles: { ...s.bubbles, [task]: { ...was, text: was.fallback, v: v + 1 } } };
  });
}

/** `task`'s bubble gone, when it still shows the saying `v` of bubble `n`, or whichever it shows without. */
export function dropBubble(task: string, n?: number, v?: number): void {
  useBubbles.setState((s) => {
    const was = s.bubbles[task];
    if (was === undefined || (n !== undefined && was.n !== n) || (v !== undefined && was.v !== v)) return s;
    const { [task]: _gone, ...rest } = s.bubbles;
    return { bubbles: rest };
  });
}

/** Every bubble gone: the rail is, the task list shown. */
export function dropAllBubbles(): void {
  useBubbles.setState({ bubbles: {} });
}
