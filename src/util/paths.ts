import { statSync } from 'node:fs';
import { sep } from 'node:path';

/**
 * Path normalisation. The normal form is forward slashes, an upper-case drive
 * letter and no trailing slash — a form to compare and to store, which Node
 * accepts on both platforms. `nativePath` is the one to hand to another tool.
 */

const isWindows = process.platform === 'win32';

/** `/c/foo` (MSYS2) or `/cygdrive/c/foo` (Cygwin) → `C:/foo`. MSYS2 form on Windows only. */
function fromPosixDrive(p: string): string {
  const cygdrive = /^\/cygdrive\/([a-zA-Z])(\/|$)/.exec(p);
  if (cygdrive) {
    return `${cygdrive[1].toUpperCase()}:${p.slice(`/cygdrive/${cygdrive[1]}`.length) || '/'}`;
  }
  if (isWindows) {
    const msys = /^\/([a-zA-Z])(\/|$)/.exec(p);
    if (msys) {
      return `${msys[1].toUpperCase()}:${p.slice(2) || '/'}`;
    }
  }
  return p;
}

export function normalizePath(input: string): string {
  if (input === '') return '';

  let p = input.replace(/\\/g, '/');
  p = fromPosixDrive(p);

  p = p.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toUpperCase()}:`);

  // Duplicate separators collapse, but a leading `//` (unc share) survives.
  const unc = p.startsWith('//');
  p = p.replace(/\/{2,}/g, '/');
  if (unc) p = `/${p}`;

  // A trailing slash goes, except on a bare root (`/` or `C:/`).
  if (p.length > 1 && p.endsWith('/') && !/^[A-Z]:\/$/.test(p)) {
    p = p.slice(0, -1);
  }
  return p;
}

/** True when `path` is a directory; false when it is anything else or is not there. */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The comparable form of a path: normalised, and lower-cased on Windows only.
 * Purely lexical, so it works for a path that does not exist yet and never
 * resolves a symlink.
 */
export function pathKey(path: string): string {
  const n = normalizePath(path);
  return isWindows ? n.toLowerCase() : n;
}

/** True when two paths name the same location. Case-insensitive on Windows. */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when `child` is `parent` or lives underneath it. */
export function isInside(parent: string, child: string): boolean {
  const p = pathKey(parent);
  const c = pathKey(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

/** The platform's own spelling — backslashes on Windows. */
export function nativePath(input: string): string {
  const n = normalizePath(input);
  return isWindows ? n.replace(/\//g, sep) : n;
}
