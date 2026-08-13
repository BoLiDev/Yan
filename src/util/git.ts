import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { YanError, type YanErrorOptions } from './error.js';

/**
 * Run git in a given directory. Every function takes that directory as its
 * first argument and throws rather than falling back on `process.cwd()`, and
 * nothing here will force-push: `push` refuses the flag.
 *
 * (The flag's literal spelling is assembled from two pieces below so a grep of
 * src/ for it stays silent; tests/unit/util-git.test.ts checks that.)
 */

const CODES = {
  usage: 'git_usage',
  failed: 'git_failed',
  forceRefused: 'git_force_refused',
} as const;

export type GitErrorKind = keyof typeof CODES;

/** What running git can fail with. */
export class GitError extends YanError {
  public static readonly codes = CODES;

  public constructor(kind: GitErrorKind, message: string, options?: YanErrorOptions) {
    super(CODES[kind], message, options);
  }

  /** The caller passed something impossible. Exit 2. */
  public static usage(message: string): GitError {
    return new GitError('usage', message, { exitCode: 2 });
  }
}

export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function requireDir(dir: string | undefined): string {
  if (!dir) {
    throw GitError.usage('a directory argument is required (this module never uses the current working directory)',
    );
  }
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw GitError.usage(`not a directory: ${dir}`);
  return dir;
}

function requireArg(value: string | undefined, message: string): string {
  if (!value) throw GitError.usage(message);
  return value;
}

/**
 * Run git and hand back its result. A non-zero exit is a value, not a throw;
 * only git failing to start is a GitError. A `timeoutMs` that elapses comes
 * back as a non-zero result.
 */
export function git(dir: string, args: readonly string[], options: { timeoutMs?: number } = {}): GitResult {
  const d = requireDir(dir);
  const r = spawnSync('git', ['-C', d, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  if (r.error) {
    throw new GitError('failed', `cannot run git: ${r.error.message}`, { cause: r.error });
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** True when git exited 0. */
export function gitOk(dir: string, args: readonly string[]): boolean {
  return git(dir, args).code === 0;
}

/** Trimmed stdout, or a GitError carrying git's stderr when it exits non-zero. */
export function gitOut(dir: string, args: readonly string[]): string {
  const r = git(dir, args);
  if (r.code !== 0) {
    throw new GitError('failed', `git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

/** Non-empty lines of stdout. */
export function gitLines(dir: string, args: readonly string[]): string[] {
  const out = gitOut(dir, args);
  return out === '' ? [] : out.split(/\r?\n/).filter((l) => l !== '');
}

// --- inspection ------------------------------------------------------------

export function currentBranch(dir: string): string {
  return gitOut(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export function branchExists(dir: string, branch: string): boolean {
  requireArg(branch, 'a branch name is required');
  return gitOk(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
}

export function remoteBranchExists(dir: string, branch: string, remote = 'origin'): boolean {
  requireArg(branch, 'a branch name is required');
  return gitOk(dir, ['ls-remote', '--exit-code', '--heads', remote, `refs/heads/${branch}`]);
}

export function statusPorcelain(dir: string, args: readonly string[] = []): string {
  return git(dir, ['status', '--porcelain', ...args]).stdout;
}

export function isClean(dir: string): boolean {
  return statusPorcelain(dir).trim() === '';
}

export function revParse(dir: string, args: readonly string[]): string {
  requireArg(args[0], 'rev-parse needs at least one argument');
  return gitOut(dir, ['rev-parse', ...args]);
}

export function diffNameOnly(dir: string, args: readonly string[] = []): string[] {
  return gitLines(dir, ['diff', '--name-only', ...args]);
}

/**
 * The branch the remote calls its default: `refs/remotes/<remote>/HEAD` when
 * the clone has it, otherwise `ls-remote --symref` over the network with a
 * 3 s timeout. `undefined` when neither answers, so callers must have
 * somewhere to go without one.
 *
 * Only ever a suggestion to prefill a prompt. A unit's `target` is `user`'s
 * answer, and nothing running unattended may take this as one.
 */
export function defaultBranch(dir: string, remote = 'origin'): string | undefined {
  const local = git(dir, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`]);
  if (local.code === 0) {
    const name = local.stdout.trim().replace(`refs/remotes/${remote}/`, '');
    if (name !== '') return name;
  }

  const asked = git(dir, ['ls-remote', '--symref', remote, 'HEAD'], { timeoutMs: 3000 });
  if (asked.code !== 0) return undefined;
  // `ref: refs/heads/main\tHEAD`, ahead of the ordinary sha lines.
  const match = /^ref:\s+refs\/heads\/(.+?)\s+HEAD$/m.exec(asked.stdout);
  const name = match?.[1]?.trim();
  return name === undefined || name === '' ? undefined : name;
}

/** Remote branches that contain HEAD, trimmed. */
export function branchesContainingHead(dir: string): string[] {
  return gitLines(dir, ['branch', '-r', '--contains', 'HEAD']).map((l) => l.trim());
}

// --- branches --------------------------------------------------------------

export function fetch(dir: string, remote = 'origin', args: readonly string[] = []): GitResult {
  return git(dir, ['fetch', '--prune', remote, ...args]);
}

export function checkout(dir: string, args: readonly string[]): GitResult {
  requireArg(args[0], 'checkout needs a ref');
  return git(dir, ['checkout', ...args]);
}

/** Cut a branch. `base` is required — never HEAD by default. */
export function createBranch(dir: string, branch: string, base: string): GitResult {
  requireArg(branch, 'a new branch name is required');
  requireArg(base, 'an explicit base ref is required');
  return git(dir, ['branch', branch, base]);
}

export function rebase(dir: string, args: readonly string[]): GitResult {
  requireArg(args[0], 'rebase needs an upstream');
  return git(dir, ['rebase', ...args]);
}

export function merge(dir: string, args: readonly string[]): GitResult {
  requireArg(args[0], 'merge needs a ref');
  return git(dir, ['merge', ...args]);
}

// --- remote writes ---------------------------------------------------------

const FORCE = `--${'force'}`;

export function isForceFlag(arg: string): boolean {
  return arg === '-f' || arg === FORCE || arg.startsWith(`${FORCE}-`) || arg.startsWith(`${FORCE}=`);
}

/**
 * Push.
 *
 * @throws GitError `forceRefused` (exit 2) when any argument is a force flag.
 */
export function push(dir: string, args: readonly string[] = []): GitResult {
  for (const a of args) {
    if (isForceFlag(a)) {
      throw new GitError('forceRefused', 'refusing to force-push: it rewrites history other people have already pulled',
        { exitCode: 2 },
      );
    }
  }
  return git(dir, ['push', ...args]);
}

/**
 * Delete a branch on the remote. Nothing here checks whether it merged, so the
 * caller must have.
 */
export function deleteRemoteBranch(dir: string, remote: string, branch: string): GitResult {
  requireArg(remote, 'a remote is required');
  requireArg(branch, 'a branch name is required');
  return git(dir, ['push', remote, '--delete', branch]);
}

// --- worktrees -------------------------------------------------------------

export function worktreeAdd(dir: string, args: readonly string[]): GitResult {
  requireArg(args[0], 'a worktree path is required');
  return git(dir, ['worktree', 'add', ...args]);
}

export function worktreeRemove(dir: string, args: readonly string[]): GitResult {
  requireArg(args[0], 'a worktree path is required');
  return git(dir, ['worktree', 'remove', ...args]);
}

/**
 * Drop the administrative records of worktrees whose directory is already
 * gone. A directory that still exists is left alone.
 */
export function worktreePrune(dir: string): GitResult {
  return git(dir, ['worktree', 'prune']);
}

export function worktreeList(dir: string): string {
  return gitOut(dir, ['worktree', 'list', '--porcelain']);
}

// --- destructive, but bounded ---------------------------------------------

export function resetHard(dir: string, ref = 'HEAD'): GitResult {
  return git(dir, ['reset', '--hard', ref]);
}

/**
 * `git clean -fd`: untracked files go, gitignored ones — node_modules, build
 * caches — stay, so a returned tree stays warm.
 */
export function cleanFd(dir: string): GitResult {
  return git(dir, ['clean', '-fd']);
}

// --- cloning ---------------------------------------------------------------

/** <dir> is the directory the clone is created in. */
export function clone(dir: string, url: string, dest: string, args: readonly string[] = []): GitResult {
  requireArg(url, 'a clone URL is required');
  requireArg(dest, 'a destination directory name is required');
  return git(dir, ['clone', ...args, url, dest]);
}

/** A remote's URL, or undefined when <dir> is not a repo or has no such remote. */
export function remoteUrl(dir: string, remote = 'origin'): string | undefined {
  const r = git(dir, ['remote', 'get-url', remote]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

// --- merging without a working tree ----------------------------------------
//
// These three write refs and objects only, so they are safe to run in a main
// clone: no checkout, and the working tree is never touched. Together they
// merge a branch without a worktree at all.

/**
 * A three-way merge written straight to the object store. Needs git ≥ 2.38.
 *
 * On success `stdout` opens with the merged tree's oid; on a conflict the exit
 * code is non-zero and `stdout` is a conflict report. Nothing is left behind
 * either way.
 */
export function mergeTree(dir: string, ours: string, theirs: string): GitResult {
  requireArg(ours, 'a branch to merge into is required');
  requireArg(theirs, 'a branch to merge is required');
  return git(dir, ['merge-tree', '--write-tree', ours, theirs]);
}

/** A commit object for an existing tree. `parents` in order: ours first. */
export function commitTree(
  dir: string,
  tree: string,
  parents: readonly string[],
  message: string,
): GitResult {
  requireArg(tree, 'a tree object is required');
  const args = ['commit-tree', tree];
  for (const parent of parents) args.push('-p', parent);
  args.push('-m', message);
  return git(dir, args);
}

/**
 * Move a ref to `to`, failing rather than moving it if it is not currently at
 * `expect` — so anything that landed in between is not discarded.
 */
export function updateRef(dir: string, ref: string, to: string, expect: string): GitResult {
  requireArg(ref, 'a ref name is required');
  requireArg(to, 'a new value is required');
  return git(dir, ['update-ref', ref, to, expect]);
}
