import type { Deliverable } from '../../records/task/index.js';
import { lineText, MAX_WIDTH, PIPE_WIDTH, wrap } from './wrap.js';

/**
 * How a task's deliverables are printed, in the one place `yan deliverable
 * ls`, `yan show` and `yan session-start` read from — the main agent and
 * `user` see the same block whichever they ran.
 *
 *   d1  done       yan ls is an overview of what is being worked on, and of
 *                  what has just landed
 *                  2026-09-18 · PR #52 · PR #53
 *   d3  todo       a task's deliverables are a record of their own
 *   d8  abandoned  units, shifts and tree counts in the overview
 *                  yan show is where those are read
 *
 * `user` reads this block to review the plan, so the text wraps to the
 * terminal under the text column rather than running off it, and the aside
 * under it wraps the same way. Nothing is ever clipped: a deliverable is a
 * sentence or two and all of it is worth reading. The geometry is `yan ls`'s,
 * down to a pipe still wrapping at 80.
 */

/**
 * What a ref points at, worked out from the ref itself. A ref is free text,
 * and `PR #58` cannot say which repository it belongs to - a task may have
 * several units in several repositories - so a ref that is a URL is the only
 * one that can be opened.
 *
 * Only `http:` and `https:` ever give an address. `javascript:` and every
 * other scheme come back as text, to be printed as they were typed.
 */
interface RefLink {
  /** How it reads: `PR #58`, `MR !87`, a host, or the ref as it was typed. */
  readonly label: string;
  /** The address to open; null when the ref is not an http(s) URL. */
  readonly href: string | null;
}

/** GitHub is one host; GitLab is self-hosted, so its merge requests are known by their path alone. */
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com']);
const PULL_PATH = /^\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/|$)/;
const MERGE_REQUEST_PATH = /\/-\/merge_requests\/(\d+)(?:\/|$)/;

/** One ref as a label and, when there is one, the address behind it. */
export function refLink(ref: string): RefLink {
  let url: URL;
  try {
    url = new URL(ref);
  } catch {
    return { label: ref, href: null };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { label: ref, href: null };
  const pull = GITHUB_HOSTS.has(url.hostname) ? PULL_PATH.exec(url.pathname) : null;
  if (pull !== null) return { label: `PR #${pull[1] as string}`, href: url.href };
  const merge = MERGE_REQUEST_PATH.exec(url.pathname);
  if (merge !== null) return { label: `MR !${merge[1] as string}`, href: url.href };
  return { label: url.host, href: url.href };
}

/**
 * A ref as everything but the record itself prints it: a URL in its short
 * form, so a line of terminal stays readable, anything else as it was typed.
 * The stored ref never changes - `yan ui --json` hands back what is on disk.
 */
function shortRef(ref: string): string {
  return refLink(ref).label;
}

/** What the file says a deliverable is done or given up for, as one short string; `''` for a to-do. */
export function deliverableAside(d: Deliverable): string {
  if (d.status === 'done') return [d.doneAt, ...(d.refs ?? []).map(shortRef)].join(' · ');
  if (d.status === 'abandoned') return d.reason;
  return '';
}

/** How each column is coloured. The default paints nothing, which is what a hook's output wants. */
interface DeliverablePaint {
  readonly id?: (s: string) => string;
  readonly status?: (s: string) => string;
  readonly text?: (s: string) => string;
  readonly aside?: (s: string) => string;
}

const AS_IS = (s: string): string => s;

/** Widest status word, so the text column lines up whatever the list holds. */
const STATUS_WIDTH = 'abandoned'.length;

/** Under this the text column is too narrow to wrap into; the terminal may fold the rest. */
const MIN_TEXT = 20;

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
  '  - write the requirements that have to be true when it is done, one statement',
  '    each, the product as the subject and never the work - user\'s example of one',
  '    is "the UI shows the title, and the title is green" - at the grain of a',
  '    user story, one thing a user can do or see, not of a test assertion:',
  '    yan deliverable add "<text>" …',
  '',
  'The list is the goal `user` and you are agreeing on, and it stays aligned with',
  'them from here on: it changes in the turn they say what the task is for has',
  'changed, and they see it as it then stands. `user` corrects both in',
  'conversation, so a first attempt is the point.',
];

/**
 * The block, wrapped to `cols` — the terminal's width, or undefined for a
 * pipe, which lays out at 80 as a card's description does. Every line after
 * the first hangs under the text column, so the id and the status stay a
 * column and a wrapped sentence still reads as one deliverable. Wide
 * characters count as two, because the wrap is the overview's own.
 */
export function deliverableLines(
  items: readonly Deliverable[],
  paint: DeliverablePaint = {},
  cols?: number,
): string[] {
  const id = paint.id ?? AS_IS;
  const status = paint.status ?? AS_IS;
  const text = paint.text ?? AS_IS;
  const aside = paint.aside ?? AS_IS;

  const idWidth = Math.max(2, ...items.map((d) => d.id.length));
  const hang = ' '.repeat(2 + idWidth + 2 + STATUS_WIDTH + 2);
  const measure = Math.max(MIN_TEXT, Math.min(cols ?? PIPE_WIDTH, MAX_WIDTH) - 1 - hang.length);
  const folded = (s: string): string[] => {
    const out = wrap(s, measure).map(lineText);
    return out.length === 0 ? [''] : out;
  };

  const lines: string[] = [];
  for (const d of items) {
    const head = `  ${id(d.id.padEnd(idWidth))}  ${status(d.status.padEnd(STATUS_WIDTH))}  `;
    folded(d.text).forEach((line, i) => lines.push((i === 0 ? head : hang) + text(line)));
    const said = deliverableAside(d);
    if (said !== '') for (const line of folded(said)) lines.push(hang + aside(line));
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
