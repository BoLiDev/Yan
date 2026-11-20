import { existsSync, lstatSync, readdirSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** What became of a change to a task's artifacts: what it is called in the commit, or why it was refused, with the status to answer with. */
export type ArtifactChange = { readonly did: string } | { readonly refused: string; readonly status: 400 | 404 | 409 };

/** A name a file or folder of the artifacts may have: one part of a path, not hidden, and none of what a path is made with. */
const named = (name: string): boolean => name !== '' && !name.startsWith('.') && !/[/\\\0]/.test(name) && name.trim() === name;

/**
 * Where `path`, a file or a folder of `id`'s artifacts as the page names
 * it, is on disk, or why it is not touched: every part of it a plain name,
 * and neither it nor a folder above it a link, which could lead a rename or
 * a delete out of the vault.
 */
function found(vaultDir: string, id: string, path: string): { at: string } | { refused: string; status: 400 | 404 } {
  const parts = path.split('/');
  if (!parts.every(named)) return { refused: `${path} is not an artifact's path`, status: 400 };
  let at = join(vaultDir, 'tasks', id, 'artifacts');
  for (const part of parts) {
    at = join(at, part);
    const is = lstatSync(at, { throwIfNoEntry: false });
    if (is === undefined) return { refused: `${id} has no artifact ${path}`, status: 404 };
    if (is.isSymbolicLink()) return { refused: `${path} is behind a link, which the page does not follow`, status: 400 };
  }
  return { at };
}

/**
 * `path` of `id`'s artifacts given the name `name`, in the folder it is in:
 * a file, or a folder with all it holds. Never over another, which would be
 * a delete nobody asked for.
 */
export function renameArtifact(vaultDir: string, id: string, path: string, name: string): ArtifactChange {
  const was = found(vaultDir, id, path);
  if ('refused' in was) return was;
  if (!named(name)) return { refused: 'a name is one word of a path: not empty, not starting with a dot, and without a slash', status: 400 };
  const to = join(dirname(was.at), name);
  if (to === was.at) return { refused: `it is already called ${name}`, status: 400 };
  // On a disk that tells no case apart, a name changed only in its case is the same file, and is not "another".
  const same = to.toLowerCase() === was.at.toLowerCase();
  if (existsSync(to) && !same) return { refused: `there is already a ${name} there`, status: 409 };
  renameSync(was.at, to);
  return { did: `${path} renamed ${name}` };
}

/** `path` of `id`'s artifacts deleted, a folder with all it holds, and the folders above it that it leaves empty, which git keeps none of. */
export function removeArtifact(vaultDir: string, id: string, path: string): ArtifactChange {
  const was = found(vaultDir, id, path);
  if ('refused' in was) return was;
  rmSync(was.at, { recursive: true });
  const top = join(vaultDir, 'tasks', id, 'artifacts');
  for (let dir = dirname(was.at); dir !== top && dir.startsWith(top) && readdirSync(dir).length === 0; dir = dirname(dir)) rmdirSync(dir);
  return { did: `${path} deleted` };
}
