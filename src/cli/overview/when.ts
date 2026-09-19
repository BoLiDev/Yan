/**
 * A point in time as the overview reports it, and how exactly it is known.
 * `task.json`, a session file, a pulse or a commit give the second; `log.md`
 * gives `MM-DD` and nothing more, so a time read off it is a day.
 */

/** Where a moment was read. */
export type MomentSource = 'task.json' | 'log' | 'session' | 'pulse' | 'status' | 'tree' | 'branch';

export interface Moment {
  /**
   * `2026-09-18T14:02:11Z` — ISO 8601 UTC to the second — when `precision`
   * is `second`; the local calendar date `2026-09-18` when it is `day`.
   */
  readonly at: string;
  readonly precision: 'second' | 'day';
  readonly source: MomentSource;
}

/** Epoch milliseconds as a second-precision moment. */
export function secondMoment(ms: number, source: MomentSource): Moment {
  return { at: `${new Date(ms).toISOString().slice(0, 19)}Z`, precision: 'second', source };
}

/** An ISO string as a second-precision moment, or undefined when it does not parse. */
export function isoMoment(iso: string | undefined, source: MomentSource): Moment | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : secondMoment(ms, source);
}

/**
 * Epoch milliseconds a moment stands for, for comparing: a day counts as the
 * start of that local day.
 */
export function momentMs(m: Moment): number {
  if (m.precision === 'second') return Date.parse(m.at);
  const [y, mo, d] = m.at.split('-').map(Number);
  return new Date(y ?? 0, (mo ?? 1) - 1, d ?? 1).getTime();
}

/** The later of two moments; the first one on a tie. */
export function later(a: Moment | undefined, b: Moment | undefined): Moment | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return momentMs(b) > momentMs(a) ? b : a;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** One `log.md` entry: its `MM-DD` and the rest of the line. */
export interface LogEntry {
  readonly mmdd: string;
  readonly text: string;
}

/** The dated entries of a `log.md`, in file order. */
export function logEntries(log: string): LogEntry[] {
  const found: LogEntry[] = [];
  for (const line of log.replace(/\r/g, '').split('\n')) {
    const m = /^- (\d{2})-(\d{2})\b\s*(.*)$/.exec(line);
    if (m === null) continue;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    found.push({ mmdd: `${m[1]}-${m[2]}`, text: m[3] ?? '' });
  }
  return found;
}

/** Day of the year, near enough to compare two `MM-DD`s. */
function dayOfYear(mmdd: string): number {
  const [m, d] = mmdd.split('-').map(Number);
  return ((m ?? 1) - 1) * 31 + (d ?? 1);
}

/**
 * The year of each `MM-DD`, given that the list is in order and none of it is
 * after `now`. Walking back from the end, the year drops by one where a date
 * is more than half a year later than the one after it: December before
 * January. A smaller step back is a line written out of order, which real
 * logs have, and stays in the same year. The last entry is dropped a year
 * when it is later in the year than `now`. Returns `YYYY-MM-DD`s.
 */
export function inferYears(mmdds: readonly string[], now: Date): string[] {
  let year = now.getFullYear();
  const today = `${two(now.getMonth() + 1)}-${two(now.getDate())}`;
  const dated: string[] = new Array<string>(mmdds.length);
  let after: string | undefined;
  for (let i = mmdds.length - 1; i >= 0; i--) {
    const mmdd = mmdds[i] as string;
    if (after === undefined ? mmdd > today : dayOfYear(mmdd) - dayOfYear(after) > 183) year -= 1;
    after = mmdd;
    dated[i] = `${year}-${mmdd}`;
  }
  return dated;
}

/** A task's closing line: `yan done` writes the first, `yan abandon` the second. */
const CLOSING = /^(?:[a-z]+\s+)?task (?:marked done|abandoned)\b/;

/** What `log.md` says about when a task opened and closed, and its last entry. */
export interface LogTimes {
  readonly opened?: Moment;
  readonly closed?: Moment;
  readonly last?: Moment;
}

export function logTimes(log: string, now: Date): LogTimes {
  const entries = logEntries(log);
  if (entries.length === 0) return {};
  const dates = inferYears(entries.map((e) => e.mmdd), now);
  const day = (i: number): Moment => ({ at: dates[i] as string, precision: 'day', source: 'log' });

  let closing = -1;
  entries.forEach((e, i) => {
    if (CLOSING.test(e.text)) closing = i;
  });
  return {
    opened: day(0),
    ...(closing >= 0 ? { closed: day(closing) } : {}),
    last: day(entries.length - 1),
  };
}
