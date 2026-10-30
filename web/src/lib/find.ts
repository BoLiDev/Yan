// Finding a task by what is typed, for ⌘K: its title or its id, best match first.

import type { TaskSummary } from './api';

export interface Found {
  readonly task: TaskSummary;
  /** Where in the title what was typed matched, as [start, end) ranges, to mark. */
  readonly marks: readonly (readonly [number, number])[];
  /** With nothing typed, why it is listed: visited of late, or open. */
  readonly group?: 'Recent' | 'Open';
}

interface Match {
  readonly score: number;
  readonly marks: [number, number][];
}

/**
 * How well one typed word matches a title: at its start best, then at the
 * start of a word in it, then anywhere, earlier better; last, its letters in
 * order with others between, as `dkm` in `dark mode`, fewer gaps better.
 */
function inTitle(title: string, term: string): Match | undefined {
  const t = title.toLowerCase();
  const at = t.indexOf(term);
  if (at === 0) return { score: 100, marks: [[0, term.length]] };
  if (at > 0) {
    const wordStart = !/[\p{L}\p{N}]/u.test(t[at - 1] as string) || /\p{Script=Han}/u.test(term[0] as string);
    return { score: (wordStart ? 80 : 60) - Math.min(at, 20) / 2, marks: [[at, at + term.length]] };
  }
  const marks: [number, number][] = [];
  let from = 0;
  for (const ch of term) {
    const i = t.indexOf(ch, from);
    if (i < 0) return undefined;
    const last = marks.at(-1);
    if (last && last[1] === i) last[1] = i + 1;
    else marks.push([i, i + 1]);
    from = i + 1;
  }
  return { score: Math.max(1, 30 - marks.length * 4), marks };
}

/** An id typed whole or by its number, `t042` or `42`, is the task; the start of one nearly so. */
function inId(id: string, term: string): number | undefined {
  if (id === term || (/^\d+$/.test(term) && Number(id.replace(/\D/g, '')) === Number(term))) return 120;
  if (id.startsWith(term)) return 90;
  return id.includes(term) ? 50 : undefined;
}

/**
 * Between tasks that match as well, the one sought most likely first:
 * waiting on `user`'s check, then in progress, then done, and given up
 * last; then the newest moved.
 */
const RANK: Readonly<Record<TaskSummary['state'], number>> = { uat: 0, open: 1, done: 2, abandoned: 3 };

function standing(a: TaskSummary, b: TaskSummary): number {
  return RANK[a.state] - RANK[b.state] || b.touched - a.touched;
}

/**
 * The tasks that match `query`, best first; every word typed has to match
 * the title or the id. With nothing typed, those visited last, the one being
 * read left out so the first is the one to go back to, then the open ones.
 */
export function findTasks(tasks: readonly TaskSummary[], query: string, recent: readonly string[], current: string | null): Found[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const visited = recent.filter((id) => id !== current).flatMap((id) => byId.get(id) ?? []).slice(0, 8);
    const shown = new Set([current, ...visited.map((t) => t.id)]);
    const open = tasks.filter((t) => !shown.has(t.id) && (t.state === 'open' || t.state === 'uat')).sort(standing);
    return [...visited.map((task) => ({ task, marks: [], group: 'Recent' as const })), ...open.map((task) => ({ task, marks: [], group: 'Open' as const }))];
  }
  const found: (Found & { score: number })[] = [];
  for (const task of tasks) {
    let score = 0;
    const marks: [number, number][] = [];
    for (const term of terms) {
      const title = inTitle(task.title, term);
      const id = inId(task.id.toLowerCase(), term);
      if (title === undefined && id === undefined) {
        score = -1;
        break;
      }
      if ((id ?? 0) > (title?.score ?? 0)) score += id as number;
      else {
        score += (title as Match).score;
        marks.push(...(title as Match).marks);
      }
    }
    if (score >= 0) found.push({ task, marks, score });
  }
  return found.sort((a, b) => b.score - a.score || standing(a.task, b.task)).map(({ task, marks }) => ({ task, marks }));
}
