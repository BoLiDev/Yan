import { momentMs, type Moment } from './when.js';

/**
 * How a moment is printed, the same way in `yan ls` and `yan show`:
 *
 *   stamp  `09-18 14:02`, when it happened: `opened`, `closed`
 *   ago    `5m ago`, how long since: `changed`, a shift's last event
 *   age    `5m`, never wider than 4 cells: "last active", under the id
 *
 * Local time throughout, and every duration floored, never rounded: a shift
 * started 40 seconds ago is `now`, not `1m ago`. A moment known to the day
 * only counts calendar days and never says minutes or hours.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const two = (n: number): string => String(n).padStart(2, '0');

const dayOnly = (m: Moment): boolean => m.precision === 'day';

function startOfDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Calendar days from `m` to `now`; never negative. */
function calendarDays(m: Moment, now: Date): number {
  return Math.max(0, Math.round((startOfDay(now.getTime()) - startOfDay(momentMs(m))) / DAY));
}

/** Local year of a moment. */
export function yearOf(m: Moment): number {
  return new Date(momentMs(m)).getFullYear();
}

/**
 * A stamp in two parts: the date, `MM-DD`, or `YYYY-MM-DD` when the year is not
 * `impliedYear`; and the time, `HH:MM`, or `''` for a moment known to the day.
 */
export function stampParts(m: Moment, impliedYear: number): { date: string; time: string } {
  const d = new Date(momentMs(m));
  const year = d.getFullYear() === impliedYear ? '' : `${d.getFullYear()}-`;
  return {
    date: `${year}${two(d.getMonth() + 1)}-${two(d.getDate())}`,
    time: dayOnly(m) ? '' : `${two(d.getHours())}:${two(d.getMinutes())}`,
  };
}

/** `09-18 14:02`; the year in front when it is not this one; the date alone for a day. */
export function stamp(m: Moment, now: Date): string {
  const { date, time } = stampParts(m, now.getFullYear());
  return time === '' ? date : `${date} ${time}`;
}

/** `now`, `7m ago`, `26h ago` (under 48 h), `37d ago` (under 100 d), then the date. */
export function ago(m: Moment, now: Date): string {
  if (dayOnly(m)) {
    const days = calendarDays(m, now);
    if (days === 0) return 'today';
    return days < 100 ? `${days}d ago` : stampParts(m, now.getFullYear()).date;
  }
  const minutes = Math.floor(Math.max(0, now.getTime() - momentMs(m)) / MINUTE);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 100 ? `${days}d ago` : stampParts(m, now.getFullYear()).date;
}

/**
 * `now`, `7m`, `26h` (under 48 h), `37d` (under 100 d), `5mo` (under 24
 * months of 30 days), `2y` (years of 365 days). A day-only moment gives `<1d`,
 * then calendar days.
 */
export function age(m: Moment, now: Date): string {
  const minutes = Math.floor(Math.max(0, now.getTime() - momentMs(m)) / MINUTE);
  const days = dayOnly(m) ? calendarDays(m, now) : Math.floor(minutes / 1440);
  if (dayOnly(m) && days === 0) return '<1d';
  if (!dayOnly(m)) {
    if (minutes < 1) return 'now';
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  }
  if (days < 100) return `${days}d`;
  const months = Math.floor(days / 30);
  return months < 24 ? `${months}mo` : `${Math.floor(days / 365)}y`;
}

/** How stale an age reads: `fresh` within the hour (never for a day), then plain, then `quiet`, then `stale`. */
export type AgeTier = 'fresh' | 'plain' | 'quiet' | 'stale';

/** Within the hour, within 48 hours, within 30 days, after that. A day counts from its start. */
export function ageTier(m: Moment, now: Date): AgeTier {
  const hours = Math.max(0, now.getTime() - momentMs(m)) / HOUR;
  if (!dayOnly(m) && hours < 1) return 'fresh';
  if (hours < 48) return 'plain';
  return hours < 30 * 24 ? 'quiet' : 'stale';
}
