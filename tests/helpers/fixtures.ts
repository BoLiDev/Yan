import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bashCommand } from '../../src/util/bash.js';

export { bashCommand };

/**
 * The vitest half of `tests/fixtures.sh`.
 *
 * plan/conventions.md §5: each test owns its temporary directory and never
 * touches the checkout's own `$YAN_HOME`. `mk_yan_home` is ported here with the
 * same shape, so a test can build a complete standalone home and drop extra
 * subcommands into it.
 *
 * ---------------------------------------------------------------------------
 * EVERY PROCESS THIS FILE STARTS IS ASYNCHRONOUS, AND THAT IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 *
 * `runYan` and `fxGit` both used `spawnSync`, and the suite ran one file at a
 * time (`fileParallelism: false`) to work around what that cost: a vitest
 * worker cannot answer the reply to its own `onTaskUpdate` while its event loop
 * is blocked, the RPC deadline is 60 s, and past it the run prints an Unhandled
 * Error and **exits 1 with every test passing**. That is the worst way for a
 * suite to fail — the first thing anyone does is stop believing the exit code.
 *
 * THE UNIT THAT MATTERS IS NOT ONE CALL, IT IS THE FILE. `await` on an
 * already-resolved promise drains microtasks; it does not turn the event loop.
 * So a file whose tests and hooks are all synchronous is ONE block from the
 * loop's point of view, however many `await`s vitest's runner performs
 * internally. Measured with a 50 ms interval timer recording its own worst gap,
 * full suite in parallel, after `runYan` alone had been made async:
 *
 *   worktree.test.ts             78 s   11 of 12 tests synchronous
 *   mr.test.ts                   64 s    6 of 7  synchronous
 *   read-only-commands.test.ts   51 s   17 of 18 synchronous
 *   display-metadata.test.ts     38 s    8 of 9  synchronous
 *   sync.test.ts                  9 s   its tests await `runYan`
 *
 * The four at or near the deadline are exactly the ones that never yield. That
 * is why `fxGit` could not stay synchronous either — and it is a different
 * reason from the one a per-call measurement gives. A realistic setup stretch
 * of ~28 git calls is 1.7 s alone and 7.7 s under 16-way contention, which
 * looks like ample headroom right up until it is the only I/O in a file that
 * has no other reason to yield.
 *
 * `mkYanHome` stays synchronous: it is `cpSync` and nothing else, it runs once
 * per home, and it now sits between awaits rather than inside a block.
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
 * One child process, awaited.
 *
 * `stdin` is closed immediately, because that is what `spawnSync` did with no
 * `input` and several tests depend on it — `continue.test.ts` uses `node` as the
 * main agent, and a `node` whose stdin never closes reads a script from it
 * forever.
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

    // Whatever happens, one settle. `spawnSync` reported a failure to start as
    // `error` plus a null status, which callers read as 1; a failure to start is
    // still a failure to run.
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
   * false for a SECOND home built inside a file that is already using one.
   */
  readonly activate?: boolean;
}

/**
 * The runtime skeleton plus a valid conf/config.json.
 *
 * `bin/` is copied in from the repository so the result is a complete,
 * standalone `$YAN_HOME`. `dist/` is copied only when asked for: a home without
 * it is the ordinary state of a fresh clone, and it is what proves `bin/yan`
 * refuses loudly rather than falling back to something that is not there.
 */
export function mkYanHome(dest: string, options: YanHomeOptions = {}): string {
  for (const d of ['mem/learnings', 'tasks', 'repos', 'conf', 'hooks', '.local']) {
    mkdirSync(join(dest, d), { recursive: true });
  }

  // The fixture home is ALSO a vault, at the same path (v3 td vault.md).
  //
  // Two roots that happen to coincide, which is a thing V3 allows and does not
  // encourage: every existing test asserts about `<home>/tasks/...`, and those
  // assertions are about yan's behaviour rather than about the layout, so
  // pointing `$YAN_VAULT` at the same directory keeps them meaningful. What it
  // does NOT do is let a test pass by accident on the old resolution — `runYan`
  // exports `$YAN_VAULT` explicitly, so a command that still reached for
  // `$YAN_HOME/tasks` would be reaching for a path nothing set.
  writeFileSync(
    join(dest, 'vault.json'),
    `${JSON.stringify({ version: 1, name: 'fixture', created: '2026-01-01' }, null, 2)}\n`,
  );

  cpSync(join(repoRoot, 'bin'), join(dest, 'bin'), { recursive: true });
  // `yan vault init` lays down `templates/vault/` and copies the config sample,
  // so a fixture home without them is not a complete mechanics clone.
  cpSync(join(repoRoot, 'templates'), join(dest, 'templates'), { recursive: true });
  cpSync(join(repoRoot, 'conf', 'config.sample.json'), join(dest, 'conf', 'config.sample.json'));
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

  // Both spellings. `<vault>/config.json` is what V3 reads; `conf/config.json`
  // is what a pre-V3 home had, and the migration test still needs to build one.
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

  // IN-PROCESS TESTS TOO, not only the ones that spawn `bin/yan`.
  //
  // Around half the suite imports a command module and calls it directly,
  // setting `process.env.YAN_HOME` by hand. Those would resolve the vault from
  // the developer's own `~/.yan` — the exact failure `runYan` isolates against
  // — so the builder points both new variables at the home it just made.
  //
  // A side effect in a builder, which is normally worth avoiding; here the
  // alternative is three lines repeated in twenty files, one of which would
  // eventually be forgotten. THE HAZARD IT CREATES IS REAL AND HAS ONE NAME: a
  // file that builds a SECOND home mid-run steals the first one's vault, and
  // the failure looks like a missing repository rather than like an env
  // variable. `activate: false` is for exactly that second home.
  if (options.activate !== false) {
    process.env.YAN_VAULT = dest;
    process.env.YAN_MACHINE_DIR = join(dest, '.machine');
  }
  return dest;
}

/**
 * Register a clone in both halves of the registry (v3 td repos.md §2).
 *
 * Tests put their clones under `<home>/repos/<name>` and used to rely on
 * `repoDir()` finding them there by convention. There is no convention any
 * more: a repository is where `.local/repos.json` says it is. The path the
 * tests use does not change — only the reason yan can find it.
 */
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
 * The vitest half of `tests/fixtures.sh`'s git universe.
 *
 * Everything goes through `fxGit`, which pins an identity and the default
 * branch name with `git -c`, so these helpers work on a machine with no global
 * git config at all (conventions §5). Nothing here touches the network.
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
 * Run `bin/yan` in a fixture home, exactly the way a person or an agent does.
 *
 * A variable set to `undefined` is UNSET rather than set to the empty string,
 * which is the only way to ask for the one case the stub cares about most: no
 * `$YAN_HOME` at all, so it has to resolve one from its own location. Without
 * it a caller has to build the environment itself, and building it means
 * spawning the child itself — which is how a second, synchronous `run bin/yan`
 * appears in a test file and blocks the worker again.
 */
export function runYan(
  home: string,
  args: readonly string[],
  env: Record<string, string | undefined> = {},
): Promise<RunResult> {
  // The vault and the machine layer are isolated for EVERY test, not only the
  // ones that care. A test that read the real `~/.yan` would pass or fail on
  // the developer's own registrations, which is the one failure a suite must
  // never have — and `doctor` reads it, so this is not hypothetical.
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
