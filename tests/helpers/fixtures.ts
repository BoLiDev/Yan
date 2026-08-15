import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bashCommand } from '../../src/util/bash.js';

export { bashCommand };

/**
 * The fixtures every test builds its world from: a throwaway `$YAN_HOME`, a
 * local git universe, and a way to run `bin/yan` against them. Nothing here
 * touches the checkout's own home or the network.
 *
 * Everything that spawns a process is async, and must stay that way: a file
 * whose tests never yield blocks its vitest worker's event loop past the rpc
 * deadline, which fails the run with every test passing.
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

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly out: string;
}

/**
 * One child process, awaited. Its stdin is closed at once, so a child that
 * reads from it sees EOF rather than waiting. Never rejects: a child that
 * cannot start comes back as code 1 with its message on stderr.
 */
function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise<RunResult>((settle) => {
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });

    // Whatever happens, one settle.
    let done = false;
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      settle({ code, stdout, stderr, out: `${stdout}${stderr}` });
    };
    child.on('error', (err: Error) => {
      stderr += `${err.message}\n`;
      finish(1);
    });
    // `code` is null when a signal killed it, which is not a pass.
    child.on('close', (code: number | null) => { finish(code ?? 1); });

    child.stdin.end();
  });
}

export interface YanHomeOptions {
  /** Copy dist/ in as well, so the ported half is reachable from the fixture. */
  readonly withDist?: boolean;
  readonly config?: string;
  /**
   * Point the vault and machine environment at this home. Default true; pass
   * false for a second home built inside a file that is already using one.
   */
  readonly activate?: boolean;
}

/**
 * A standalone `$YAN_HOME` that is also a vault, with `bin/`, `templates/` and
 * a config. Without `withDist` it has no `dist/`, which is what a fresh clone
 * looks like. Unless `activate` is false it also points `$YAN_VAULT` and
 * `$YAN_MACHINE_DIR` at itself, for tests that call a command in process.
 */
export function mkYanHome(dest: string, options: YanHomeOptions = {}): string {
  for (const d of ['mem/learnings', 'tasks', 'repos', 'conf', 'hooks', '.local']) {
    mkdirSync(join(dest, d), { recursive: true });
  }

  writeFileSync(
    join(dest, 'vault.json'),
    `${JSON.stringify({ version: 1, name: 'fixture', created: '2026-01-01' }, null, 2)}\n`,
  );

  cpSync(join(repoRoot, 'bin'), join(dest, 'bin'), { recursive: true });
  // `yan vault init` reads templates/, so a home without it is incomplete.
  cpSync(join(repoRoot, 'templates'), join(dest, 'templates'), { recursive: true });
  if (options.withDist === true) {
    cpSync(join(repoRoot, 'dist'), join(dest, 'dist'), { recursive: true });
    cpSync(join(repoRoot, 'package.json'), join(dest, 'package.json'));
    // Linked, not copied: a junction needs no administrator on Windows.
    symlinkSync(
      join(repoRoot, 'node_modules'),
      join(dest, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }

  // Both spellings: `<vault>/config.json` is what yan reads, and
  // `conf/config.json` is what the migration test needs to find.
  const configText =
    options.config ??
    `${JSON.stringify(
      {
        version: 1,
        agents: { yan: 'claude', shift: 'claude' },
        remote_git: { kind: 'github' },
      },
      null,
      2,
    )}\n`;
  writeFileSync(join(dest, 'config.json'), configText);
  writeFileSync(join(dest, 'conf', 'config.json'), configText);
  writeFileSync(join(dest, 'mem', 'repos.json'), '{\n  "version": 1\n}\n');
  writeFileSync(join(dest, 'repos.json'), '{\n  "version": 1\n}\n');
  writeFileSync(join(dest, '.local', 'repos.json'), '{\n  "version": 1\n}\n');

  // A second home built mid-file would otherwise steal the first one's vault.
  if (options.activate !== false) {
    process.env.YAN_VAULT = dest;
    process.env.YAN_MACHINE_DIR = join(dest, '.machine');
  }
  return dest;
}

/** Register a clone in both halves of a vault's registry. */
export function registerRepo(
  vault: string,
  name: string,
  dir: string,
  entry: { url?: string; mode_default?: string; pool_size?: number } = {},
): void {
  const portable = join(vault, 'repos.json');
  const local = join(vault, '.local', 'repos.json');
  const read = (file: string): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      return { version: 1 };
    }
  };

  const reg = read(portable);
  reg[name] = {
    url: entry.url ?? `file://${dir}`,
    mode_default: entry.mode_default ?? 'mr',
    pool_size: entry.pool_size ?? 8,
  };
  writeFileSync(portable, `${JSON.stringify(reg, null, 2)}\n`);

  mkdirSync(join(vault, '.local'), { recursive: true });
  const loc = read(local);
  loc[name] = { path: dir.replace(/\\/g, '/') };
  writeFileSync(local, `${JSON.stringify(loc, null, 2)}\n`);
}

/**
 * git with an identity, a default branch name and signing pinned on the
 * command line, so it works on a machine with no global git config.
 */
export function fxGit(args: readonly string[], cwd?: string): Promise<RunResult> {
  return run(
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
    { cwd },
  );
}

/** A bare repo with nothing in it — what a forge hands you after "New repository". */
export async function mkEmptyRemote(bare: string): Promise<string> {
  mkdirSync(bare, { recursive: true });
  await fxGit(['init', '--bare', '--initial-branch=main', bare]);
  return bare;
}

/** A bare repo with one commit on `main`. */
export async function mkBareRemote(bare: string): Promise<string> {
  mkdirSync(bare, { recursive: true });
  await fxGit(['init', '--bare', '--initial-branch=main', bare]);

  const seed = mkTempDir('yan-seed-');
  await fxGit(['init', '--initial-branch=main', seed]);
  writeFileSync(join(seed, 'README.md'), 'fixture repository\n');
  await fxGit(['add', 'README.md'], seed);
  await fxGit(['commit', '-m', 'initial commit'], seed);
  await fxGit(['remote', 'add', 'origin', bare], seed);
  await fxGit(['push', '-u', 'origin', 'main'], seed);
  rmSync(seed, { recursive: true, force: true });
  return bare;
}

/** A working clone with a local identity configured. */
export async function mkClone(bare: string, dir: string): Promise<string> {
  mkdirSync(join(dir, '..'), { recursive: true });
  await fxGit(['clone', bare, dir]);
  await fxGit(['config', 'user.name', 'yan tests'], dir);
  await fxGit(['config', 'user.email', 'yan-tests@localhost'], dir);
  await fxGit(['config', 'commit.gpgsign', 'false'], dir);
  return dir;
}

/** One commit adding or replacing a file. */
export async function mkCommit(dir: string, rel: string, body: string, message?: string): Promise<void> {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, `${body}\n`);
  await fxGit(['add', '--', rel], dir);
  await fxGit(['commit', '-m', message ?? `add ${rel}`], dir);
}

/**
 * Run `bin/yan` in a fixture home, the way a person or an agent does. The home
 * is also the vault and the machine directory.
 *
 * @param env overrides; a variable set to `undefined` is unset rather than
 *   emptied, which is how to ask for no `$YAN_HOME` at all.
 */
export function runYan(
  home: string,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    YAN_HOME: home,
    YAN_VAULT: home,
    YAN_MACHINE_DIR: join(home, '.machine'),
  };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return run(bashCommand(), [join(home, 'bin', 'yan'), ...args], { env: merged });
}
