// How a task is told apart where there is room for one character, as on the
// rail the task list folds to: a capital letter, or a Chinese character, and
// never two run together, which reads as a word nobody wrote.

import type { TaskSummary } from './api';

/** A character of a script written without spaces, each one standing for a word or a syllable of its own. */
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * The characters a title can be told by, the likeliest first: its first
 * word's first letter or digit, capitalised, then each next word's; in
 * Chinese or Japanese, its first character, then each after it. A title
 * with none, the last digit of the task's number.
 */
function letterings(title: string, id: string): string[] {
  const out: string[] = [];
  for (const word of title.split(/[\s\-_/·.,:;!?|()[\]{}<>"'`，、。：；！？（）【】《》「」]+/u)) {
    const chars = [...word].filter((c) => /[\p{L}\p{N}]/u.test(c));
    const first = chars[0];
    if (first === undefined) continue;
    if (WIDE.test(first)) out.push(...chars.filter((c) => WIDE.test(c)));
    else out.push(first.toUpperCase());
  }
  if (out.length === 0) out.push(id.replace(/\D/g, '').slice(-1) || (id[0] ?? '?').toUpperCase());
  return [...new Set(out)];
}

/**
 * Each task's character on the rail. The tasks pick in the order they were
 * made, so one keeps its character while newer ones come and go, and one
 * whose likeliest is taken takes the next of its own; when all of its own
 * are taken, it shares its first.
 */
export function initialsOf(tasks: readonly TaskSummary[]): ReadonlyMap<string, string> {
  const taken = new Set<string>();
  const out = new Map<string, string>();
  for (const t of [...tasks].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))) {
    const ways = letterings(t.title, t.id);
    const pick = ways.find((w) => !taken.has(w)) ?? (ways[0] as string);
    taken.add(pick);
    out.set(t.id, pick);
  }
  return out;
}
