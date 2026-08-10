import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The vitest half of `tests/fixtures.sh`.
 *
 * plan/conventions.md §5: each test owns its temporary directory and never
 * touches the checkout's own `$YAN_HOME`. `mk_yan_home` is ported here with the
 * same shape, so a test can build a complete standalone home and drop extra
 * subcommands into it.
 */

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const created: string[] = [];

/** A throwaway directory. `cleanupTempDirs()` removes every one of them. */
export function mkTempDir(prefix = 'yan-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTempDirs(): void {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir === undefined) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface YanHomeOptions {
  /** Copy dist/ in as well, so the ported half is reachable from the fixture. */
  readonly withDist?: boolean;
  readonly config?: string;
}

/**
 * The runtime skeleton plus a valid conf/config.json.
 *
 * `bin/` is copied in from the repository so the result is a complete,
 * standalone `$YAN_HOME`. `dist/` is copied only when asked for: a home without
 * it is the ordinary state of a fresh clone, and it is what proves the shell
 * fallback still works.
 */
export function mkYanHome(dest: string, options: YanHomeOptions = {}): string {
  for (const d of ['mem/learnings', 'tasks', 'repos', 'conf']) {
    mkdirSync(join(dest, d), { recursive: true });
  }

  cpSync(join(repoRoot, 'bin'), join(dest, 'bin'), { recursive: true });
  if (options.withDist === true) {
    cpSync(join(repoRoot, 'dist'), join(dest, 'dist'), { recursive: true });
    cpSync(join(repoRoot, 'package.json'), join(dest, 'package.json'));
    // node_modules is linked, not copied: a junction needs no administrator on
    // Windows and copying it would dominate the runtime of every test.
    symlinkSync(
      join(repoRoot, 'node_modules'),
      join(dest, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }

  writeFileSync(
    join(dest, 'conf', 'config.json'),
    options.config ??
      `${JSON.stringify(
        {
          version: 1,
          agents: { yan: 'claude', shift: 'claude' },
          forge: { kind: 'github' },
          backend: 'tmux',
        },
        null,
        2,
      )}\n`,
  );
  writeFileSync(join(dest, 'mem', 'repos.json'), '{\n  "version": 1\n}\n');
  return dest;
}
