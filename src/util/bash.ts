import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Which bash to run, on a machine that may have more than one.
 *
 * ---------------------------------------------------------------------------
 * WHY `bash` IS NOT AN ANSWER ON WINDOWS
 * ---------------------------------------------------------------------------
 *
 * A developer box with WSL installed has `bash.exe` in
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`, and that directory usually comes
 * before Git's on PATH. So a bare `bash` reaches the WSL launcher, which is a
 * Linux shell in a Linux filesystem: `C:/Users/x/bin/yan` is not a path it can
 * open, under any spelling short of `/mnt/c/...`. What comes back is
 *
 *     /bin/bash: C:/Users/x/bin/yan: No such file or directory
 *
 * which reads like a missing file and is nothing of the kind — the file is
 * there, and the shell looking for it is in another operating system.
 *
 * Git Bash is the one that shares a filesystem with the rest of yan, and it
 * takes a Windows path in either slash direction, so the fix is to name it
 * rather than to reformat what we hand to whatever answers.
 *
 * `YAN_BASH` overrides everything, for a machine whose Git lives somewhere no
 * list would guess. Elsewhere — macOS, Linux — there is one bash and PATH finds
 * it.
 */

let cached: string | undefined;

/** Git's install root, derived from wherever `git` itself resolves. */
function gitRoot(): string | undefined {
  const where = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
  const first = (where.stdout ?? '').split(/\r?\n/).find((l) => l.trim() !== '');
  // …\Git\cmd\git.exe and …\Git\bin\git.exe both sit two levels below the root.
  return first === undefined ? undefined : dirname(dirname(first.trim()));
}

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

  // No Git Bash found. `bash` may still be right — a machine with MSYS2 or
  // Cygwin on PATH and no Git for Windows — and a clear failure from the child
  // beats a guess thrown here.
  cached = 'bash';
  return cached;
}
