import { spawnSync } from 'node:child_process';
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

/**
 * The vitest half of `tests/fixtures.sh`'s git universe.
 *
 * Everything goes through `fxGit`, which pins an identity and the default
 * branch name with `git -c`, so these helpers work on a machine with no global
 * git config at all (conventions §5). Nothing here touches the network.
 */
export function fxGit(args: readonly string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(
    'git',
    [
      '-c', 'user.name=yan tests',
      '-c', 'user.email=yan-tests@localhost',
      '-c', 'init.defaultBranch=main',
      '-c', 'commit.gpgsign=false',
      '-c', 'tag.gpgsign=false',
      '-c', 'advice.detachedHead=false',
      '-c', 'protocol.file.allow=always',
      ...args,
    ],
    { cwd, encoding: 'utf8', windowsHide: true },
  );
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A bare repo with one commit on `main`. */
export function mkBareRemote(bare: string): string {
  mkdirSync(bare, { recursive: true });
  fxGit(['init', '--bare', '--initial-branch=main', bare]);

  const seed = mkTempDir('yan-seed-');
  fxGit(['init', '--initial-branch=main', seed]);
  writeFileSync(join(seed, 'README.md'), 'fixture repository\n');
  fxGit(['add', 'README.md'], seed);
  fxGit(['commit', '-m', 'initial commit'], seed);
  fxGit(['remote', 'add', 'origin', bare], seed);
  fxGit(['push', '-u', 'origin', 'main'], seed);
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** A working clone with a local identity configured. */
export function mkClone(bare: string, dir: string): string {
  mkdirSync(join(dir, '..'), { recursive: true });
  fxGit(['clone', bare, dir]);
  fxGit(['config', 'user.name', 'yan tests'], dir);
  fxGit(['config', 'user.email', 'yan-tests@localhost'], dir);
  fxGit(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

/** One commit adding or replacing a file. */
export function mkCommit(dir: string, rel: string, body: string, message?: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, `${body}\n`);
  fxGit(['add', '--', rel], dir);
  fxGit(['commit', '-m', message ?? `add ${rel}`], dir);
}

/** Run `bin/yan` in a fixture home, exactly the way a person or an agent does. */
export function runYan(
  home: string,
  args: readonly string[],
  env: Record<string, string> = {},
): { code: number; stdout: string; stderr: string; out: string } {
  const r = spawnSync('bash', [join(home, 'bin', 'yan'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, YAN_HOME: home, ...env },
    windowsHide: true,
  });
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return { code: r.status ?? 1, stdout, stderr, out: `${stdout}${stderr}` };
}
