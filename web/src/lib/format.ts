// Words for times and sizes. Times are Unix seconds, as the server sends them.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const pad = (n: number): string => String(n).padStart(2, '0');
export const nowS = (): number => Math.floor(Date.now() / 1000);
export const fromIso = (iso: string | null | undefined): number => (iso ? Math.floor(new Date(iso).getTime() / 1000) || 0 : 0);

export function monthName(m: number): string {
  return MONTHS[m] ?? String(m + 1);
}

export function dayOf(ts: number): string {
  const d = new Date(ts * 1000);
  const y = d.getFullYear() === new Date().getFullYear() ? '' : `, ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${y}`;
}

export function clock(ts: number, seconds = false): string {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? ':' + pad(d.getSeconds()) : ''}`;
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function yesterday(): Date {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return y;
}

export function when(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  if (sameDay(d, new Date())) return `today ${clock(ts)}`;
  if (sameDay(d, yesterday())) return `yesterday ${clock(ts)}`;
  return `${dayOf(ts)} ${clock(ts)}`;
}

export function dayLabel(ts: number): string {
  const d = new Date(ts * 1000);
  if (sameDay(d, new Date())) return 'Today';
  if (sameDay(d, yesterday())) return 'Yesterday';
  return `${WEEKDAYS[d.getDay()]}, ${dayOf(ts)}`;
}

export function monthLabel(ts: number): string {
  const d = new Date(ts * 1000);
  return MONTHS_LONG[d.getMonth()] + (d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`);
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const short = (sha: string | null | undefined): string => (sha || '').slice(0, 7);
export const plural = (n: number, one: string, many?: string): string => `${n.toLocaleString()} ${n === 1 ? one : many || one + 's'}`;

/** The key ⌘K and its kin are pressed with here, as a person reads it: ⌘ on a Mac, Ctrl+ elsewhere. */
export const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
