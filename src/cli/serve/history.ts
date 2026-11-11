import { gitAsync } from './blobs.js';
import type { FileVersion } from './wire.js';

/**
 * A file of the vault as it has been, version by version: every commit
 * that changed it, the newest first, with the file as that commit left it
 * and as it found it. The vault's history is the record: an agent's push
 * and an edit on the page are both commits, so nothing more is kept. The
 * page shows one version against the one before by the two blobs, which
 * is the change whatever commits lie between and however they were joined.
 */

/** The most versions listed: the recent ones are what is looked for. */
export const HISTORY_MOST = 50;

/**
 * The versions of `path`, from the vault's root, in the history of `commit`.
 * A commit that deleted it is among them, with no blob after; the one that
 * added it has none before.
 */
export async function fileHistory(dir: string, commit: string, path: string, most = HISTORY_MOST): Promise<FileVersion[]> {
  const r = await gitAsync(dir, ['log', `-n${most}`, '--format=%x1e%H%x1f%ct%x1f%an%x1f%s', '--raw', '--numstat', '--no-abbrev', '--no-renames', commit, '--', path]);
  if (r.code !== 0) return [];
  const versions: FileVersion[] = [];
  for (const part of r.stdout.split('\x1e').slice(1)) {
    const [head = '', ...rest] = part.split('\n');
    const [sha = '', at = '0', author = '', ...subject] = head.split('\x1f');
    // `:100644 100644 <before> <after> M\t<path>`, a blob of zeros standing for none.
    const raw = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) /m.exec(rest.join('\n'));
    if (raw === null) continue;
    const counts = /^(\d+|-)\t(\d+|-)\t/m.exec(rest.join('\n'));
    const blob = (s: string | undefined): string | null => (s === undefined || /^0+$/.test(s) ? null : s);
    versions.push({
      commit: sha,
      at: Number(at),
      author,
      subject: subject.join('\x1f'),
      sha: blob(raw[2]),
      before: blob(raw[1]),
      add: counts === null || counts[1] === '-' ? null : Number(counts[1]),
      del: counts === null || counts[2] === '-' ? null : Number(counts[2]),
    });
  }
  return versions;
}

/** What turns the blob `a` into the blob `b`, as `git diff` says it, with `context` lines around each change; undefined when git cannot say. */
export async function blobDiff(dir: string, a: string, b: string, whole: boolean, limit: number): Promise<string | undefined> {
  const r = await gitAsync(dir, ['diff', '--no-color', '--no-ext-diff', whole ? '-U100000' : '-U3', a, b], 60_000, limit);
  return r.code === 0 || r.code === 1 ? r.stdout : undefined;
}
