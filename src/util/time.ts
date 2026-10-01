/**
 * How yan writes a moment. Two spellings and no third: a timestamp is ISO 8601
 * in UTC to the second, and a day is the local calendar day — the day `user`
 * would name, so `log.md` and a deliverable's `doneAt`
 * agree with each other and with the wall clock.
 */

const two = (n: number): string => String(n).padStart(2, '0');

/** `2026-09-18T14:02:11Z`: UTC, to the second. */
export function isoSecond(d: Date = new Date()): string {
  return `${d.toISOString().slice(0, 19)}Z`;
}

/** `2026-09-18`, the local day. */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${localMonthDay(d)}`;
}

/** `09-18`, the local day without its year, as `log.md` dates an entry. */
export function localMonthDay(d: Date = new Date()): string {
  return `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** `14:02`, local time; `14:02:11` with `seconds`. */
export function localTime(d: Date, seconds = false): string {
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return seconds ? `${hm}:${two(d.getSeconds())}` : hm;
}

/** `2026-09-18 14:02`, local. */
export function localStamp(d: Date): string {
  return `${localDay(d)} ${localTime(d)}`;
}

/** `YYYY-MM-DD`, and a day that exists: `2026-02-30` is not one. */
export function isDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  return d <= new Date(y, mo, 0).getDate();
}
