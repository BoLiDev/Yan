import { YanError } from './error.js';
import { NOT_STARTED, runProcess, type ProcessResult } from './process.js';
import { isDirectory } from './paths.js';

/**
 * Run git in a given directory. Every function takes that directory as its
 * first argument and throws rather than falling back on `process.cwd()`.
 * Nothing here pushes: the one push yan makes is `yan vault push`, of the
 * vault, and src/util/git.test.ts checks no force flag reaches git anywhere.
 */

function requireDir(dir: string | undefined): string {
  if (!dir) {
    throw YanError.usage('git_usage', 'a directory argument is required (this module never uses the current working directory)',
    );
  }
  if (!isDirectory(dir)) throw YanError.usage('git_usage', `not a directory: ${dir}`);
  return dir;
}

/**
 * Kept only where git would answer a missing argument with something other
 * than a refusal: `show-ref` on an empty ref says "no", `checkout` with no
 * ref prints the branch, `rev-parse` with none exits 0 saying nothing, and
 * bare `git rebase` rebases onto the configured upstream. Everywhere else the
 * guard was a worse copy of what git already reports.
 */
function requireArg(value: string | undefined, message: string): string {
  if (!value) throw YanError.usage('git_usage', message);
  return value;
}

/**
 * Run git and hand back its result. A non-zero exit is a value, not a throw;
 * only git failing to start is a YanError. A `timeoutMs` that elapses comes
 * back as a non-zero result.
 */
export function git(dir: string, args: readonly string[], options: { timeoutMs?: number } = {}): ProcessResult {
  const d = requireDir(dir);
  const r = runProcess('git', ['-C', d, ...args], options);
  if (r.code === NOT_STARTED) throw new YanError('git_failed', `cannot run git: ${r.stderr}`);
  return r;
}

/** True when git exited 0. */
export function gitOk(dir: string, args: readonly string[]): boolean {
  return git(dir, args).code === 0;
}

/** Trimmed stdout, or a YanError carrying git's stderr when it exits non-zero. */
function gitOut(dir: string, args: readonly string[]): string {
  const r = git(dir, args);
  if (r.code !== 0) {
    throw new YanError('git_failed', `git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

/** Non-empty lines of stdout. */
function gitLines(dir: string, args: readonly string[]): string[] {
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

/**
 * The branch the remote calls its default: `refs/remotes/<remote>/HEAD` when
 * the clone has it, otherwise `ls-remote --symref` over the network with a
 * 3 s timeout. `undefined` when neither answers, so callers must have
 * somewhere to go without one.
 *
 * What a new task's tree is cut from.
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

export function fetch(dir: string, remote = 'origin', args: readonly string[] = []): ProcessResult {
  return git(dir, ['fetch', '--prune', remote, ...args]);
}

export function checkout(dir: string, args: readonly string[]): ProcessResult {
  requireArg(args[0], 'checkout needs a ref');
  return git(dir, ['checkout', ...args]);
}

export function rebase(dir: string, args: readonly string[]): ProcessResult {
  requireArg(args[0], 'rebase needs an upstream');
  return git(dir, ['rebase', ...args]);
}

// --- worktrees -------------------------------------------------------------

export function worktreeAdd(dir: string, args: readonly string[]): ProcessResult {
  return git(dir, ['worktree', 'add', ...args]);
}

/**
 * Drop the administrative records of worktrees whose directory is already
 * gone. A directory that still exists is left alone.
 */
export function worktreePrune(dir: string): ProcessResult {
  return git(dir, ['worktree', 'prune']);
}

export function worktreeList(dir: string): string {
  return gitOut(dir, ['worktree', 'list', '--porcelain']);
}

// --- destructive, but bounded ---------------------------------------------

export function resetHard(dir: string, ref = 'HEAD'): ProcessResult {
  return git(dir, ['reset', '--hard', ref]);
}

/**
 * `git clean -fd`: untracked files go, gitignored ones — node_modules, build
 * caches — stay, so a returned tree stays warm.
 */
export function cleanFd(dir: string): ProcessResult {
  return git(dir, ['clean', '-fd']);
}

// --- remotes ---------------------------------------------------------------

/** A remote's URL, or undefined when <dir> is not a repo or has no such remote. */
export function remoteUrl(dir: string, remote = 'origin'): string | undefined {
  const r = git(dir, ['remote', 'get-url', remote]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}
