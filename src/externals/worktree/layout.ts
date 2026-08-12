import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { normalizePath } from '../../util/paths.js';
import { WorktreeError } from './errors.js';

/**
 * Where the pool keeps things:
 *
 *   <pool root>/<repo>-<hash>/
 *     leases/<slot>.json     runtime records. They belong to the pool, not to
 *                            a task, so they never live under $YAN_HOME
 *     <slot>/<repo>/         the tree itself
 *
 * The pool root is ~/.yan-trees, overridden by $YAN_POOL_ROOT.
 */

export function absolute(path: string): string {
  return normalizePath(resolve(path));
}

/** Not a security boundary: it only keeps two clones with the same basename in different pools. */
function shortHash(text: string, length = 8): string {
  return createHash('sha1').update(text).digest('hex').slice(0, length);
}

export function repoName(clone: string): string {
  return basename(normalizePath(clone).replace(/\/+$/, '')).replace(/\.git$/, '');
}

/**
 * The comparable form of a path. Purely lexical, so it works for paths that do
 * not exist yet. Lower-cased on Windows only, because two spellings that differ
 * in case are the same directory there and the same comparison would be wrong
 * on Linux.
 */
export function pathKey(path: string): string {
  const n = normalizePath(path);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

export function rootDir(): string {
  const root = process.env.YAN_POOL_ROOT ?? join(homedir(), '.yan-trees');
  try {
    mkdirSync(root, { recursive: true });
  } catch (cause) {
    throw new WorktreeError(
      'failed',
      `cannot create the pool root: ${root} - set YAN_POOL_ROOT to a writable directory`,
      { cause },
    );
  }
  return absolute(root);
}

/** This clone's pool: `<root>/<repo>-<hash>`. */
export function cloneDir(clone: string): string {
  if (!clone) throw WorktreeError.usage('a main clone directory is required');
  const abs = absolute(clone);
  return `${rootDir()}/${repoName(abs)}-${shortHash(pathKey(abs))}`;
}

export function leasesDir(dir: string): string {
  return join(dir, 'leases');
}

export function leaseFile(dir: string, slot: number): string {
  return join(leasesDir(dir), `${slot}.json`);
}

export function lockFile(dir: string): string {
  return join(dir, 'lock');
}

/** The tree a slot holds, whether or not it exists yet. */
export function slotTree(dir: string, slot: number, name: string): string {
  return normalizePath(join(dir, String(slot), name));
}
