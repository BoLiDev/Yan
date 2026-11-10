/**
 * Where each Markdown file was last being read, by its path in the vault,
 * kept in this browser: a file opened again, from another or after a
 * reload, opens there, and so does the same file once an agent has changed
 * it. A place is a line of the source, with how far into it, and the words
 * of the first lines with any at or after it: an agent writing above it
 * moves the line, and the words find it again.
 */

interface Spot {
  /** The line of the source at the top of the view, with how far into it. */
  readonly line: number;
  /** How many blank lines there are from that line to the first with words. */
  readonly skip: number;
  /** The words of that line and the next few, as they were. */
  readonly quote: readonly string[];
}

const KEY = 'yan.serve.reading';
/** The files a browser keeps a place for, the ones read last. */
const MOST = 200;
/** Lines the words are taken from: enough to tell one paragraph's first line from another's like it. */
const QUOTE = 3;

function load(): Map<string, Spot> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return new Map(Array.isArray(raw) ? (raw as [string, Spot][]).filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1]?.line === 'number') : []);
  } catch {
    return new Map();
  }
}

let spots = load();
let writing: ReturnType<typeof setTimeout> | undefined;

/** Written to the browser a moment after the reading stops moving, not at every scroll. */
function persist(): void {
  clearTimeout(writing);
  writing = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify([...spots]));
    } catch {
      // A browser that keeps nothing keeps the places for as long as the page is open.
    }
  }, 500);
}

/** Note that the file at `path`, whose source is `text`, is being read at `line`. */
export function keepSpot(path: string, text: string, line: number): void {
  const lines = text.split('\n');
  const at = Math.max(0, Math.floor(line));
  let skip = 0;
  while (at + skip < lines.length && (lines[at + skip] ?? '').trim() === '') skip++;
  const spot: Spot = { line, skip, quote: lines.slice(at + skip, at + skip + QUOTE) };
  spots.delete(path);
  spots.set(path, spot);
  while (spots.size > MOST) spots.delete(spots.keys().next().value as string);
  persist();
}

/**
 * The line of `text` the file at `path` was being read at, or null when it
 * has not been read here: where its words are now, the nearest such place to
 * where they were; where they are gone, the line as it was.
 */
export function spotIn(path: string, text: string): number | null {
  const spot = spots.get(path);
  if (spot === undefined) return null;
  const lines = text.split('\n');
  const at = Math.floor(spot.line);
  const into = spot.line - at;
  const first = spot.quote[0];
  if (first === undefined) return Math.min(spot.line, Math.max(0, lines.length - 1));
  const fits = (i: number): boolean => spot.quote.every((q, k) => lines[i + k] === q);
  // Searched outward from where the words were, so of two places alike the nearer wins.
  const was = at + spot.skip;
  for (let d = 0; d < lines.length; d++) {
    for (const i of d === 0 ? [was] : [was - d, was + d]) {
      if (i >= 0 && i < lines.length && lines[i] === first && fits(i)) return Math.max(0, i - spot.skip) + into;
    }
  }
  return Math.min(spot.line, Math.max(0, lines.length - 1));
}

/** Every place forgotten: a test's page starts with none. */
export function forgetSpots(): void {
  clearTimeout(writing);
  spots = new Map();
}
