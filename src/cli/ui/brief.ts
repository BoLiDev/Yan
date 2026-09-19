import { unwrapParagraph } from '../overview/description.js';

/**
 * The Deliverables list of a `brief.md`, for `yan ui`: what a task set out to
 * deliver, and which of it is done. Lifted from the design's `mock/parse.mjs`,
 * which made the data `user` accepted; `data-shape.md` states the rules.
 */

export type Mark = 'todo' | 'done' | 'dropped';

export interface Deliverable {
  readonly mark: Mark;
  /** Local `YYYY-MM-DD`, for a `done` item whose text starts with a date; null otherwise. */
  readonly date: string | null;
  /** A leading `PR #54` or `MR !87`, lifted off the text; null when there is none. */
  readonly evidence: string | null;
  readonly text: string;
}

/**
 *   sections   it has `## Description` or `## Deliverables`, and every top-level
 *              bullet under Deliverables carries one of the three marks
 *   free-form  anything else: nothing is parsed
 *   missing    no brief.md
 */
export type BriefShape = 'sections' | 'free-form' | 'missing';

export interface ParsedBrief {
  readonly shape: BriefShape;
  /** Empty unless the shape is `sections`. */
  readonly deliverables: readonly Deliverable[];
}

/** The lines under `## <name>`, up to the next heading of that level or above; undefined without one. */
function section(lines: readonly string[], name: string): string[] | undefined {
  const at = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\s*$`, 'i').test(l));
  if (at < 0) return undefined;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
  return end < 0 ? rest : rest.slice(0, end);
}

const MARKS: Readonly<Record<string, Mark>> = { ' ': 'todo', x: 'done', X: 'done', '-': 'dropped' };

/**
 * `MM-DD` with no year is the latest such date that is not after `notAfter`
 * (a local `YYYY-MM-DD`): a brief never records the future.
 */
export function resolveYear(monthDay: string, notAfter: string): string {
  const year = Number(notAfter.slice(0, 4));
  return `${year}-${monthDay}` <= notAfter ? `${year}-${monthDay}` : `${year - 1}-${monthDay}`;
}

/**
 * A leading `PR #54 · ` or `MR !87 · ` is evidence, not prose: lifted out so the
 * sentence starts with what was delivered. Only when the reference is followed at
 * once by ` · `; `PR #53 for the data; … · ` keeps its words and is left alone.
 */
export function liftEvidence(text: string): { evidence: string | null; text: string } {
  const m = /^(PR #\d+|MR !\d+)\s+·\s+/.exec(text);
  return m === null ? { evidence: null, text } : { evidence: m[1] as string, text: text.slice(m[0].length) };
}

/** `MM-DD` names a month and a day in it; `02-29` counts. */
function realMonthDay(monthDay: string): boolean {
  const [m, d] = monthDay.split('-').map(Number) as [number, number];
  return m >= 1 && m <= 12 && d >= 1 && d <= new Date(2000, m, 0).getDate();
}

const FREE_FORM: ParsedBrief = { shape: 'free-form', deliverables: [] };

/**
 * brief.md → its shape and deliverables, in file order. `notAfter` is the day no
 * date may be after: the completion day for a finished task, today for one in
 * progress. Against today, a task closed on 2025-03-10 with an item `03-05` would
 * read 2026-03-05 a year on.
 */
export function parseBrief(text: string | undefined, notAfter: string): ParsedBrief {
  if (text === undefined) return { shape: 'missing', deliverables: [] };
  const lines = text.replace(/\r/g, '').replace(/\s+$/, '').split('\n');
  const body = section(lines, 'Deliverables');
  if (body === undefined && section(lines, 'Description') === undefined) return FREE_FORM;

  const items: { mark: Mark; lines: string[] }[] = [];
  let current: { mark: Mark; lines: string[] } | null = null;
  for (const line of body ?? []) {
    const item = /^- \[( |x|X|-)\]\s+(.*)$/.exec(line);
    if (item !== null) {
      current = { mark: MARKS[item[1] as string] as Mark, lines: [item[2] as string] };
      items.push(current);
    } else if (/^[-*+]\s/.test(line)) {
      return FREE_FORM; // a bullet with no mark: do not guess which it is
    } else if (/^\s+\S/.test(line) && current !== null) {
      current.lines.push(line);
    } else if (line.trim() !== '') {
      current = null; // a paragraph between items belongs to no item
    }
  }

  const deliverables = items.map(({ mark, lines: own }): Deliverable => {
    // A nested bullet keeps its own line; everything else is one paragraph.
    const chunks: string[][] = [[]];
    for (const l of own) {
      if (/^\s+[-*+]\s/.test(l)) chunks.push([l.trim()]);
      else (chunks[chunks.length - 1] as string[]).push(l);
    }
    let body = chunks.map((c) => unwrapParagraph(c.join('\n'))).filter((c) => c !== '').join('\n');
    let date: string | null = null;
    const dated = /^(?:(\d{4})-)?(\d{2}-\d{2})(?:\s+·\s+|\s+|$)/.exec(body);
    if (mark === 'done' && dated !== null && realMonthDay(dated[2] as string)) {
      const monthDay = dated[2] as string;
      date = dated[1] !== undefined ? `${dated[1]}-${monthDay}` : resolveYear(monthDay, notAfter);
      body = body.slice(dated[0].length);
    }
    return { mark, date, ...liftEvidence(body) };
  });
  return { shape: 'sections', deliverables };
}
