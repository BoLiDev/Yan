import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
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
  // As git will spell it: `git worktree list` reports real paths, and the pool
  // is keyed by the clone's path, so a clone or a pool root reached through a
  // symlink (macOS's /var -> /private/var, every $TMPDIR) would otherwise get
  // one key when spelled one way and another key the other way. A path that
  // does not exist yet is kept as given.
  const abs = resolve(path);
  try {
    return normalizePath(realpathSync(abs));
  } catch {
    return normalizePath(abs);
  }
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

/**
 * This clone's pool: `<root>/<repo>-<hash>`, the hash taken over the clone's
 * real path. A pool made by an earlier yan was keyed by the path as spelled,
 * which differs from the real one when the clone is reached through a
 * symlink; such a pool is kept as it is rather than orphaned with its trees,
 * so it is used for as long as no pool under the real key exists.
 */
export function cloneDir(clone: string): string {
  if (!clone) throw WorktreeError.usage('a main clone directory is required');
  const abs = absolute(clone);
  const root = rootDir();
  const dir = `${root}/${repoName(abs)}-${shortHash(pathKey(abs))}`;
  const spelled = normalizePath(resolve(clone));
  if (spelled !== abs) {
    const legacy = `${root}/${repoName(spelled)}-${shortHash(pathKey(spelled))}`;
    if (!existsSync(dir) && existsSync(legacy)) return legacy;
  }
  return dir;
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
