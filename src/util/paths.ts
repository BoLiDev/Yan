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

/** True when two paths name the same location. Case-insensitive on Windows. */
export function samePath(a: string, b: string): boolean {
  const na = normalizePath(a);
  const nb = normalizePath(b);
  return isWindows ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** True when `child` is `parent` or lives underneath it. */
export function isInside(parent: string, child: string): boolean {
  const p = normalizePath(parent);
  const c = normalizePath(child);
  if (samePath(p, c)) return true;
  const prefix = p.endsWith('/') ? p : `${p}/`;
  return isWindows ? c.toLowerCase().startsWith(prefix.toLowerCase()) : c.startsWith(prefix);
}

/** The platform's own spelling — backslashes on Windows. */
export function nativePath(input: string): string {
  const n = normalizePath(input);
  return isWindows ? n.replace(/\//g, sep) : n;
}
