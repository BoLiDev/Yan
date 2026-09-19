import { homedir } from 'node:os';

/**
 * Colour for what a person reads in a terminal, and nothing for a pipe: on
 * when stdout is a TTY, off under `NO_COLOR`, forced by `FORCE_COLOR` (any
 * value but `0`). Every painter returns its input unchanged when colour is off,
 * so what a test or a script captures is plain text.
 */

function enabled(): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== '') return force !== '0';
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return false;
  return process.stdout.isTTY === true;
}

type Paint = (text: string) => string;

function sgr(open: string, close: string): Paint {
  return (text) => (text === '' || !enabled() ? text : `\x1b[${open}m${text}\x1b[${close}m`);
}

export const bold = sgr('1', '22');
export const dim = sgr('2', '22');
export const red = sgr('31', '39');
export const green = sgr('32', '39');
export const yellow = sgr('33', '39');
export const blue = sgr('34', '39');
export const magenta = sgr('35', '39');
export const cyan = sgr('36', '39');
export const gray = sgr('90', '39');

/**
 * How many columns a line may take: the terminal's width when stdout is one,
 * `$COLUMNS` when it is set, and `undefined` otherwise — a pipe gets every
 * line whole.
 */
export function terminalWidth(): number | undefined {
  if (process.stdout.isTTY === true && process.stdout.columns > 0) return process.stdout.columns;
  const columns = Number.parseInt(process.env.COLUMNS ?? '', 10);
  return Number.isNaN(columns) || columns <= 0 ? undefined : columns;
}

/** Columns a character takes: two for East Asian wide and fullwidth forms, one otherwise. */
export function columnsOf(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
    ? 2
    : 1;
}

/** Columns a string takes, a wide character counting two. Plain text only. */
export function cells(text: string): number {
  let n = 0;
  for (const char of text) n += columnsOf(char);
  return n;
}

/** `text` padded with spaces to `width` columns. */
export function padEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - cells(text)));
}

/** `text` padded on the left with spaces to `width` columns. */
export function padStart(text: string, width: number): string {
  return ' '.repeat(Math.max(0, width - cells(text))) + text;
}

/**
 * `text` cut to `width` columns, ending in `…` when anything was cut, with no
 * space before it. A wide character that would straddle the edge is left out,
 * so an odd width can leave one column unused. Plain text only.
 */
export function fit(text: string, width: number): string {
  if (cells(text) <= width) return text;
  let used = 0;
  let out = '';
  for (const char of text) {
    const w = columnsOf(char);
    if (used + w > width - 1) break;
    out += char;
    used += w;
  }
  return `${out.trimEnd()}…`;
}

/** `path` with the home directory spelled `~`, in forward slashes. */
export function tildePath(path: string): string {
  const home = homedir().replace(/\\/g, '/').replace(/\/$/, '');
  const p = path.replace(/\\/g, '/');
  return home !== '' && p.toLowerCase().startsWith(`${home.toLowerCase()}/`) ? `~${p.slice(home.length)}` : p;
}
