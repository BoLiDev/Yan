import { deliverableAside, type Deliverable } from '../../records/task/index.js';

/**
 * How a task's deliverables are printed, in the one place both `yan
 * session-start` and `yan show` read from — the main agent sees the same
 * block whichever it ran.
 *
 *   d1  done       yan ls is an overview of what is being worked on
 *                  2026-09-18 · PR #52 · PR #53
 *   d3  todo       a task's deliverables are a record of their own
 *   d8  abandoned  units, shifts and tree counts in the overview
 *                  yan show is where those are read
 *
 * The text is printed as it was written: it is a sentence or two, and nothing
 * here wraps or clips it.
 */

/** How each column is coloured. The default paints nothing, which is what a hook's output wants. */
export interface DeliverablePaint {
  readonly id?: (s: string) => string;
  readonly status?: (s: string) => string;
  readonly text?: (s: string) => string;
  readonly aside?: (s: string) => string;
}

const AS_IS = (s: string): string => s;

/** Widest status word, so the text column lines up whatever the list holds. */
const STATUS_WIDTH = 'abandoned'.length;

/**
 * What the main agent is told at session start when a task has no
 * deliverables yet: the brief it has is still the seed `user` typed, and
 * breaking it down comes before anything else it might do this turn.
 *
 * Session start only. It is addressed to the agent reading its own startup,
 * and `yan show` is read by `user` at a terminal, where it would be an
 * instruction to nobody.
 */
export const NO_DELIVERABLES_NOTICE: readonly string[] = [
  'This task has never been broken down: brief.md is still the seed `user` gave',
  "when the task was created, and nothing says what it has to build. Do that now,",
  'before anything else, and show `user` the result in your first reply:',
  '',
  '  - rewrite brief.md as the background and the problems to solve, short prose,',
  '    no headings, no history and no dates;',
  "  - write what has to be built to solve them: yan deliverable add \"<text>\" …",
  '',
  '`user` corrects both in conversation, so a first attempt is the point.',
];

/** One line per deliverable, plus one for its date and refs, or its reason. */
export function deliverableLines(
  items: readonly Deliverable[],
  paint: DeliverablePaint = {},
): string[] {
  const id = paint.id ?? AS_IS;
  const status = paint.status ?? AS_IS;
  const text = paint.text ?? AS_IS;
  const aside = paint.aside ?? AS_IS;

  const idWidth = Math.max(2, ...items.map((d) => d.id.length));
  const hang = ' '.repeat(2 + idWidth + 2 + STATUS_WIDTH + 2);

  const lines: string[] = [];
  for (const d of items) {
    lines.push(`  ${id(d.id.padEnd(idWidth))}  ${status(d.status.padEnd(STATUS_WIDTH))}  ${text(d.text)}`);
    const said = deliverableAside(d);
    if (said !== '') lines.push(hang + aside(said));
  }
  return lines;
}

/** `2 done · 1 abandoned · 3 to do`, leaving out what there is none of; `''` for an empty list. */
export function deliverableTally(items: readonly Deliverable[]): string {
  const count = (s: Deliverable['status']): number => items.filter((d) => d.status === s).length;
  return [
    count('done') > 0 ? `${count('done')} done` : '',
    count('abandoned') > 0 ? `${count('abandoned')} abandoned` : '',
    count('todo') > 0 ? `${count('todo')} to do` : '',
  ]
    .filter((s) => s !== '')
    .join(' · ');
}
