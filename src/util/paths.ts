import { sep } from 'node:path';

/**
 * Path normalisation, in one place (plan/conventions.md §3).
 *
 * Node removes most of the MVP's `cygpath` problem but not all of it: on
 * Windows `git` and `herdr` both report native paths (`C:\…` or `C:/…`) while a
 * path `yan` built may be POSIX (`/c/…`) if it came out of a Git Bash
 * environment variable. Any comparison between a path we built and a path an
 * external tool printed has to normalise first, and this is the only module
 * allowed to know that.
 *
 * The normal form is: forward slashes, an upper-case drive letter, no trailing
 * slash. It is a *comparison* form, not a form to hand back to the OS — Node
 * accepts it on both platforms, which is why nothing else needs converting.
 */

const isWindows = process.platform === 'win32';

/** `/c/foo` (MSYS2) or `/cygdrive/c/foo` (Cygwin) → `C:/foo`. */
function fromPosixDrive(p: string): string {
  const cygdrive = /^\/cygdrive\/([a-zA-Z])(\/|$)/.exec(p);
  if (cygdrive) {
    return `${cygdrive[1].toUpperCase()}:${p.slice(`/cygdrive/${cygdrive[1]}`.length) || '/'}`;
  }
  // Only treat /x/… as a drive on Windows: on Linux /c/foo is a real directory
  // and rewriting it to C:/foo would be a data-loss bug rather than a nicety.
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

  // Upper-case the drive letter so `c:/x` and `C:/x` compare equal.
  p = p.replace(/^([a-zA-Z]):/, (_m, d: string) => `${d.toUpperCase()}:`);

  // Collapse duplicate separators, but keep a leading `//` (UNC share).
  const unc = p.startsWith('//');
  p = p.replace(/\/{2,}/g, '/');
  if (unc) p = `/${p}`;

  // Drop a trailing slash, except for a bare root (`/` or `C:/`).
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

/** The platform's own spelling, for handing a path back to a tool or the OS. */
export function nativePath(input: string): string {
  const n = normalizePath(input);
  return isWindows ? n.replace(/\//g, sep) : n;
}
