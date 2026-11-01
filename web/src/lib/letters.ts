// How a task is told apart where there is room for two letters, as on the
// rail the task list folds to.

import type { TaskSummary } from './api';

/**
 * The ways a title can be told in two letters, the likeliest first: its
 * first two words' first letters, its first word's first two, its first and
 * last words' first; one in Chinese or Japanese, its first character, then
 * its first two. A title of none, the task's number.
 */
function letterings(title: string, id: string): string[] {
  const words = title.trim().split(/[\s\-_/·.:]+/).filter(Boolean);
  const first = words[0] ?? '';
  const number = id.replace(/^\D+/, '').slice(-2) || id.slice(0, 2);
  if (!first) return [number];
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(first)) return [[...first].slice(0, 1).join(''), [...first].slice(0, 2).join(''), number];
  const last = words.at(-1) ?? first;
  return [...new Set([words[1] ? first[0] + words[1][0] : first.slice(0, 2), first.slice(0, 2), first[0] + last[0], number].map((x) => x.toUpperCase()))];
}

/** Each task's letters on the rail, in the rail's order, a task whose likeliest letters are taken taking the next of its own. */
export function initialsOf(tasks: readonly TaskSummary[]): ReadonlyMap<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const t of tasks) {
    const ways = letterings(t.title, t.id);
    const pick = ways.find((w) => !taken.has(w)) ?? (ways[0] as string);
    taken.add(pick);
    out.set(t.id, pick);
  }
  return out;
}
