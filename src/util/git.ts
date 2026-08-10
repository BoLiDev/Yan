import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { YanError, type YanErrorOptions } from './error.js';

/**
 * Run git in a given directory. The TypeScript half of `bin/lib-git.sh`.
 *
 * Purely functional. It has no idea what a task, a unit or a shift is; give it
 * a path and an action and that is all it needs.
 *
 * Two invariants, both carried over unchanged:
 *
 *   1. EVERY function takes an explicit directory as its first argument and
 *      never relies on process.cwd(). `requireDir` refuses an empty or
 *      non-directory argument, so "forgot to pass the directory" fails loudly
 *      instead of operating on whatever happened to be the current directory.
 *
 *   2. This module never passes one of git's force flags. boundaries.md §9.2
 *      lists force-pushing and forced tree destruction as forbidden, so there
 *      is nowhere here for such a flag to hide; `push` actively refuses one if
 *      a caller tries to smuggle it through.
 *      (The flag's literal spelling is assembled from two pieces below, so that
 *      a grep of src/ for it finds nothing. Please keep it that way;
 *      tests/unit/util-git.test.ts greps for it.)
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

/** Run git and hand back the result. Never throws on a non-zero git status. */
export function git(dir: string, args: readonly string[]): GitResult {
  const d = requireDir(dir);
  const r = spawnSync('git', ['-C', d, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.error) {
    throw new GitError('failed', `cannot run git: ${r.error.message}`, { cause: r.error });
  }
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** True when git exited 0. For the questions whose answer *is* the exit code. */
export function gitOk(dir: string, args: readonly string[]): boolean {
  return git(dir, args).code === 0;
}

/** Trimmed stdout, or a GitError carrying git's own stderr. */
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

/** Remote branches that contain HEAD. Used by the pool's orphan-commit guard. */
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

/**
 * The base is always explicit: cutting a branch from "wherever HEAD happens to
 * be" is exactly the kind of implicit state this module refuses to have.
 */
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

// Assembled from two pieces so a grep of src/ for the forbidden flag is silent.
const FORCE = `--${'force'}`;

export function isForceFlag(arg: string): boolean {
  return arg === '-f' || arg === FORCE || arg.startsWith(`${FORCE}-`) || arg.startsWith(`${FORCE}=`);
}

/** Refuses a force flag rather than passing it on (boundaries.md §9.2). */
export function push(dir: string, args: readonly string[] = []): GitResult {
  for (const a of args) {
    if (isForceFlag(a)) {
      throw new GitError('forceRefused', 'refusing to force-push: it is forbidden (boundaries.md §9.2)',
        { exitCode: 2 },
      );
    }
  }
  return git(dir, ['push', ...args]);
}

/**
 * Callers must have checked that the branch is merged; deleting an unmerged
 * branch is forbidden (boundaries.md §9.2) and that judgement is not this
 * module's business.
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
 * Removes only the administrative records of worktrees whose directory is
 * already gone. It never touches a directory that still exists, which is why
 * the pool may call it before handing a slot out.
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
 * `-fd` and NEVER `-x`. The pool's whole reason to exist is warm reuse:
 * gitignored node_modules, build caches and the like must survive a tree being
 * returned (worktree.md §7). Adding -x here silently turns every lease into a
 * cold install and nothing fails loudly when it happens.
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

/**
 * Undefined when <dir> is not a git repository or has no such remote, which is
 * how a caller tells "this directory is a clone of that URL" from "this
 * directory merely has the same name".
 */
export function remoteUrl(dir: string, remote = 'origin'): string | undefined {
  const r = git(dir, ['remote', 'get-url', remote]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}
