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
 *     leases/<slot>.json     the lease records
 *     <slot>/<repo>/         the tree itself
 *
 * The pool root is ~/.yan-trees, overridden by $YAN_POOL_ROOT.
 */

export function absolute(path: string): string {
  return normalizePath(resolve(path));
}

/** Short and non-cryptographic: it only keeps same-named clones in different pools. */
function shortHash(text: string, length = 8): string {
  return createHash('sha1').update(text).digest('hex').slice(0, length);
}

export function repoName(clone: string): string {
  return basename(normalizePath(clone).replace(/\/+$/, '')).replace(/\.git$/, '');
}

/**
 * The comparable form of a path, lower-cased on Windows. Purely lexical, so it
 * works for a path that does not exist yet and never resolves a symlink.
 */
export function pathKey(path: string): string {
  const n = normalizePath(path);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

/** Creates the pool root if it is absent. */
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
