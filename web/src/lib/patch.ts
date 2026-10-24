import { colourLines } from './highlight';

export interface PatchLine {
  readonly k: 'add' | 'del' | 'ctx';
  /** The line's number on the old side, and on the new. */
  readonly a?: number;
  readonly b?: number;
  readonly t: string;
  /** The line coloured, as HTML, when it could be. */
  h?: string | null;
}

export interface Hunk {
  readonly head: string;
  readonly lines: PatchLine[];
}

export interface PatchFile {
  from: string | null;
  to: string | null;
  path: string | null;
  readonly hunks: Hunk[];
  binary: boolean;
  readonly note: string[];
}

/** `git diff` output, file by file and hunk by hunk. */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let f: PatchFile | null = null;
  let hunk: Hunk | null = null;
  let a = 0;
  let b = 0;
  const unq = (p: string): string => (p.startsWith('"') ? p.slice(1, -1).replace(/\\(.)/g, '$1') : p);
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      f = { from: null, to: null, path: null, hunks: [], binary: false, note: [] };
      files.push(f);
      hunk = null;
      continue;
    }
    if (!f) continue;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
      if (!m) continue;
      a = Number(m[1]);
      b = Number(m[2]);
      hunk = { head: line, lines: [] };
      f.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (line.startsWith('--- ')) f.from = unq(line.slice(4)).replace(/^a\//, '');
      else if (line.startsWith('+++ ')) f.to = unq(line.slice(4)).replace(/^b\//, '');
      else if (line.startsWith('Binary files')) f.binary = true;
      else if (line.startsWith('rename from ')) f.from = line.slice(12);
      else if (line.startsWith('rename to ')) f.to = line.slice(10);
      else if (line.startsWith('new file mode')) f.note.push('new file');
      else if (line.startsWith('deleted file mode')) f.note.push('deleted');
      continue;
    }
    const c = line.charAt(0);
    if (c === '+') hunk.lines.push({ k: 'add', b: b++, t: line.slice(1) });
    else if (c === '-') hunk.lines.push({ k: 'del', a: a++, t: line.slice(1) });
    else if (c === ' ') hunk.lines.push({ k: 'ctx', a: a++, b: b++, t: line.slice(1) });
  }
  for (const x of files) x.path = x.to && x.to !== '/dev/null' ? x.to : x.from;
  return files;
}

/** A hunk's lines side by side: each removed line beside the line added in its place, context on both. */
export function splitPairs(lines: readonly PatchLine[]): [PatchLine | null, PatchLine | null][] {
  const out: [PatchLine | null, PatchLine | null][] = [];
  let dels: PatchLine[] = [];
  let adds: PatchLine[] = [];
  const flush = (): void => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push([dels[i] ?? null, adds[i] ?? null]);
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.k === 'del') {
      if (adds.length) flush();
      dels.push(l);
    } else if (l.k === 'add') adds.push(l);
    else {
      flush();
      out.push([l, l]);
    }
  }
  flush();
  return out;
}

/**
 * Each side of a hunk coloured as one piece: the old side (context and
 * removed lines) by old line number, the new (context and added) by new.
 * A side too long to colour gives an empty map, and its lines stay plain.
 */
function colourSides(hk: Hunk, lang: string): { byA: Map<number | undefined, string>; byB: Map<number | undefined, string> } {
  const old = hk.lines.filter((l) => l.k !== 'add');
  const now = hk.lines.filter((l) => l.k !== 'del');
  const a = colourLines(lang, old.map((l) => l.t).join('\n'));
  const b = colourLines(lang, now.map((l) => l.t).join('\n'));
  return {
    byA: new Map(a ? old.map((l, i) => [l.a, a[i] as string]) : []),
    byB: new Map(b ? now.map((l, i) => [l.b, b[i] as string]) : []),
  };
}

/**
 * Colour a parsed file's hunks in place. With `whole`, the same file's diff
 * with every line as context, each side is coloured entire, so a construct
 * is right however far it spans and wherever a hunk cuts it. Without, each
 * hunk's two sides are coloured on their own, and one open at a hunk's
 * edge, a block comment most often, is read as code until it closes.
 */
export function colourPatch(f: PatchFile, lang: string | null, whole: PatchFile | null = null): void {
  if (!lang) return;
  const entire = whole && whole.hunks.length === 1 ? colourSides(whole.hunks[0] as Hunk, lang) : null;
  for (const hk of f.hunks) {
    const { byA, byB } = entire ?? colourSides(hk, lang);
    for (const l of hk.lines) l.h = l.k === 'del' ? byA.get(l.a) : byB.get(l.b);
  }
}
