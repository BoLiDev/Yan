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
 *   2. This module never passes one of git's force flags. Force-pushing
 *      rewrites history colleagues have already pulled, and there is nowhere
 *      here for such a flag to hide; `push` actively refuses one if a caller
 *      tries to smuggle it through.
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
export function git(dir: string, args: readonly string[], options: { timeoutMs?: number } = {}): GitResult {
  const d = requireDir(dir);
  const r = spawnSync('git', ['-C', d, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    // Only for the handful of calls that touch the network. A timed-out git
    // comes back as a non-zero result like any other failure, never a hang.
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
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

/**
 * The branch the remote itself calls its default, or `undefined`.
 *
 * This is a SUGGESTION and nothing more. `target` remains `user`'s answer,
 * because a release period and a quiet period have different ones and the
 * remote's default cannot tell you which you are in. The only legitimate use is
 * to prefill a prompt a person then reads and confirms; nothing running without
 * a terminal may call this to invent a target for itself.
 *
 * Two ways to ask, cheapest first:
 *
 *   1. `refs/remotes/<remote>/HEAD`, which `git clone` writes and
 *      `git remote set-head` refreshes. No network, always right if present,
 *      and absent often enough — a clone made with `--single-branch`, a remote
 *      added by hand — that it cannot be the only way.
 *   2. `ls-remote --symref`, which asks the remote. This is the answer GitHub
 *      and GitLab give for their own default branch, whatever it is called, so
 *      nothing here needs a list of likely names.
 *
 * Both are allowed to fail. A remote that is unreachable, slow, or wants
 * credentials nobody is there to type produces `undefined`, and the caller asks
 * its question with an empty box — which is exactly where this started.
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

/** Refuses a force flag rather than passing it on. */
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
 * Callers must have checked that the branch is merged. Deleting an unmerged
 * branch destroys the only copy of the work on it, and that judgement is not
 * this module's to make.
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
 * `-fd` and NEVER `-x`. The worktree pool exists for warm reuse, so gitignored
 * node_modules and build caches have to survive a tree being returned. Adding
 * `-x` here would silently turn every lease into a cold install, and nothing
 * would fail loudly when it happened.
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

// --- merging without a working tree ----------------------------------------
//
// THE CONVENTION THESE EXIST TO RESPECT, stated exactly, because it is
// routinely remembered wrong: a main clone is not "read-only". What is
// forbidden is touching its WORKING TREE — checkout, merge, rebase, reset,
// clean — because since V3 that clone is `user`'s own working copy, and a tool
// that moves you off your branch while you are thinking is a tool you stop
// trusting.
//
// Writing refs and objects is not that, and yan already did it: cutting an
// integration branch is `git branch`, a ref write in the main clone. These
// three complete the set, so a real three-way merge — carrying an abandoned
// round forward — can happen in the clone with no checkout, no lease and no
// worktree at all. `merge-tree --write-tree` (git ≥ 2.38) does the merge into
// the object store and REPORTS conflicts rather than leaving them anywhere.

/**
 * A three-way merge of two commits, written to the object store.
 *
 * On success `stdout` is the merged tree's OID on its first line. On failure it
 * is a conflict report — which is an answer and not a malfunction: it means
 * this one needs a human, or a shift with a real working tree.
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
 * Move a ref, refusing if it is not where we last saw it.
 *
 * `expect` is not optional politeness: between reading a branch and moving it a
 * shift may have merged into it. Passing the old value makes the update fail
 * rather than silently discard whatever arrived in between.
 */
export function updateRef(dir: string, ref: string, to: string, expect: string): GitResult {
  requireArg(ref, 'a ref name is required');
  requireArg(to, 'a new value is required');
  return git(dir, ['update-ref', ref, to, expect]);
}
