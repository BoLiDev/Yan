import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Which bash to run. On Windows this is Git Bash by absolute path, never a
 * bare `bash` — that reaches WSL's launcher, which cannot open a `C:/…` path
 * and reports it as a missing file. `$YAN_BASH` overrides everything.
 */

let cached: string | undefined;

/** Git's install root, two levels above wherever `git` itself resolves. */
function gitRoot(): string | undefined {
  const where = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
  const first = (where.stdout ?? '').split(/\r?\n/).find((l) => l.trim() !== '');
  return first === undefined ? undefined : dirname(dirname(first.trim()));
}

/** Cached after the first call. Falls back to `bash` when nothing is found. */
export function bashCommand(): string {
  if (cached !== undefined) return cached;

  const override = process.env.YAN_BASH;
  if (override !== undefined && override !== '') {
    cached = override;
    return cached;
  }

  if (process.platform !== 'win32') {
    cached = 'bash';
    return cached;
  }

  const roots = [
    gitRoot(),
    process.env.ProgramFiles === undefined ? undefined : join(process.env.ProgramFiles, 'Git'),
    process.env['ProgramW6432'] === undefined ? undefined : join(process.env['ProgramW6432'], 'Git'),
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, 'Programs', 'Git'),
  ];

  for (const root of roots) {
    if (root === undefined) continue;
    for (const rel of [join('bin', 'bash.exe'), join('usr', 'bin', 'bash.exe')]) {
      const candidate = join(root, rel);
      if (existsSync(candidate)) {
        cached = candidate;
        return cached;
      }
    }
  }

  // No Git Bash found; MSYS2 or Cygwin on PATH may still answer.
  cached = 'bash';
  return cached;
}
