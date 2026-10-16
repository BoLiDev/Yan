import { defaultBranch } from '../../util/git.js';
import { repoKey } from '../../util/repo-key.js';
import type { ProcessResult } from '../../util/process.js';
import { BlobReader, gitAsync } from './blobs.js';

/**
 * A task's branch, as `yan serve` shows it: what it changes against the
 * default branch, its commits, and every file at its head. All of it comes
 * from the clone this machine keeps of the repository, the one
 * `~/.yan/config.json` names, which is fetched into refs of the server's own
 * so no branch, work tree or remote-tracking ref of anyone else's moves.
 *
 * A branch already merged is compared from where it left the default
 * branch, not from the default branch's head: against that it changes
 * nothing. Where it left is the merge commit's first parent, and GitHub's
 * merge commit names the pull request.
 */

/** The server's own copies of origin's branches. */
const OWN = 'refs/yan/serve/heads/';
/** Large enough for any file a person reads; a patch longer than this is cut. */
export const PATCH_LIMIT = 2_000_000;

export interface BranchCommit {
  readonly sha: string;
  readonly at: number;
  readonly author: string;
  readonly subject: string;
}

export interface BranchFile {
  readonly path: string;
  /** Where a renamed file came from. */
  readonly from: string | null;
  /** A, M, D, R, C, T. */
  readonly status: string;
  /** null for a binary file. */
  readonly add: number | null;
  readonly del: number | null;
}

export interface BranchView {
  readonly repo: string;
  readonly url: string;
  readonly branch: string;
  readonly clone: string | null;
  /** Why there is nothing more to show; null when there is. */
  readonly missing: string | null;
  readonly fetchedAt: number | null;
  readonly fetchError: string | null;
  readonly target: string;
  readonly base: string;
  readonly head: string;
  readonly merged: { readonly sha: string; readonly at: number; readonly pr: number | null } | null;
  readonly ahead: number;
  readonly behind: number;
  readonly links: { readonly pr: string | null; readonly compare: string | null; readonly branch: string | null };
  readonly commits: readonly BranchCommit[];
  readonly files: readonly BranchFile[];
}

/** A branch name safe to put in a refspec and on a command line. */
export function isBranchName(name: string): boolean {
  return /^[\w][\w./@+-]*$/.test(name) && !name.includes('..') && !name.endsWith('.lock') && !name.endsWith('/');
}

/** `https://github.com/owner/repo` for a GitHub URL, otherwise null. */
export function githubBase(url: string): string | null {
  const key = repoKey(url);
  return key.startsWith('github.com/') ? `https://${key}` : null;
}

/** The pull request a merge commit's subject names: GitHub writes `Merge pull request #79 from …`. */
export function prOf(subject: string): number | null {
  const m = /^Merge pull request #(\d+)\b/.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
  return m === null ? null : Number(m[1]);
}

/** One fetch of these branches into this clone; another branch of it is fetched on its own. */
function fetchKey(clone: string, branches: readonly string[]): string {
  return [clone, ...branches].join('\n');
}

async function out(dir: string, args: readonly string[]): Promise<string | undefined> {
  const r = await gitAsync(dir, args);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

/**
 * The head `branch` had when a merge on `tip` took it in, found by what the
 * merge says: GitHub's `Merge pull request #N from <owner>/<branch>`, or
 * git's own `Merge branch '<branch>'`. The newest such merge wins.
 */
export async function mergedHead(clone: string, tip: string, branch: string): Promise<string | undefined> {
  const log = await out(clone, ['log', tip, '--merges', '--fixed-strings', `--grep=${branch}`, '-n', '50', '--format=%P%x1f%s']);
  for (const line of (log ?? '').split(/\r?\n/)) {
    const [parents = '', subject = ''] = line.split('\x1f');
    const names = subject.endsWith(`/${branch}`) || subject.endsWith(` ${branch}`) || subject.includes(`'${branch}'`);
    const second = parents.split(' ')[1];
    if (names && second !== undefined && second !== '') return second;
  }
  return undefined;
}

async function firstRef(dir: string, refs: readonly string[]): Promise<string | undefined> {
  for (const ref of refs) {
    const sha = await out(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (sha !== undefined && sha !== '') return sha;
  }
  return undefined;
}

/** Parse `git diff --name-status -z` and `--numstat -z` of the same range into one list. */
export function changedFiles(nameStatus: string, numstat: string): BranchFile[] {
  const counts = new Map<string, { add: number | null; del: number | null }>();
  const n = numstat.split('\0');
  for (let i = 0; i < n.length; i++) {
    const field = n[i] as string;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(field);
    if (m === null) continue;
    const add = m[1] === '-' ? null : Number(m[1]);
    const del = m[2] === '-' ? null : Number(m[2]);
    // A rename leaves the path empty and puts the old and new paths in the next two fields.
    let path = m[3] as string;
    if (path === '') {
      path = n[i + 2] ?? '';
      i += 2;
    }
    counts.set(path, { add, del });
  }

  const files: BranchFile[] = [];
  const s = nameStatus.split('\0');
  for (let i = 0; i < s.length; i++) {
    const status = s[i] as string;
    if (status === '') continue;
    const letter = status.charAt(0);
    let from: string | null = null;
    let path = s[++i] ?? '';
    if (letter === 'R' || letter === 'C') {
      from = path;
      path = s[++i] ?? '';
    }
    const c = counts.get(path) ?? { add: null, del: null };
    files.push({ path, from, status: letter, add: c.add, del: c.del });
  }
  return files;
}

/**
 * Every clone the server reads, with its blob reader, the default branch it
 * found once, and when each branch was last fetched. A fetch already in
 * flight is joined rather than started again.
 */
export class Branches {
  private readonly readers = new Map<string, BlobReader>();
  private readonly targets = new Map<string, string>();
  private readonly fetched = new Map<string, { at: number; error: string | null; running?: Promise<void> }>();

  /** @param everyS how stale a fetch may be before a look at the branch fetches again. */
  public constructor(private readonly everyS: number) {}

  public reader(clone: string): BlobReader {
    let r = this.readers.get(clone);
    if (r === undefined) this.readers.set(clone, (r = new BlobReader(clone)));
    return r;
  }

  public async close(): Promise<void> {
    await Promise.all([...this.readers.values()].map((r) => r.close()));
  }

  /**
   * The branch and what it changes, fetching both it and the default branch
   * when they are stale. With `wait`, what the fetch brought, rather than
   * what the clone had before it.
   */
  public async view(url: string, branch: string, clone: string | undefined, wait = false): Promise<BranchView> {
    const github = githubBase(url);
    const empty = {
      repo: repoKey(url).split('/').pop() ?? url,
      url,
      branch,
      clone: clone ?? null,
      fetchedAt: null,
      fetchError: null,
      target: '',
      base: '',
      head: '',
      merged: null,
      ahead: 0,
      behind: 0,
      links: { pr: null, compare: null, branch: github === null ? null : `${github}/tree/${branch}` },
      commits: [],
      files: [],
    };
    if (!isBranchName(branch)) return { ...empty, missing: `"${branch}" is not a branch name git takes` };
    if (clone === undefined) {
      return { ...empty, missing: `this machine has no clone of ${empty.repo} - 'yan repo' links one` };
    }

    const target = this.targetOf(clone);
    const headRefs = [`${OWN}${branch}`, `refs/remotes/origin/${branch}`, `refs/heads/${branch}`];
    const tipRefs = [`${OWN}${target}`, `refs/remotes/origin/${target}`, `refs/heads/${target}`];
    // What the clone already has is shown at once and the fetch goes on
    // behind it; the page asks again on its next tick and gets the fetched
    // branch then. Only a branch the clone has never seen waits for it.
    const fetching = this.fetch(clone, [target, branch], wait);
    if (wait) await fetching;
    let head = await firstRef(clone, headRefs);
    let tip = await firstRef(clone, tipRefs);
    if (head === undefined || tip === undefined) {
      await fetching;
      head = await firstRef(clone, headRefs);
      tip = await firstRef(clone, tipRefs);
    }
    const state = this.fetched.get(fetchKey(clone, [target, branch]));
    const fetchedAt = state?.at || null;
    const fetchError = state?.error ?? null;
    // Deleted from origin before this clone ever had it: the merge that took
    // it in still names it, and its second parent is the head it had.
    if (head === undefined && tip !== undefined) head = await mergedHead(clone, tip, branch);
    if (head === undefined) {
      return { ...empty, fetchedAt, fetchError, target, missing: `${branch} is not on origin, and ${empty.repo}'s clone has no copy of it` };
    }
    if (tip === undefined) {
      return { ...empty, fetchedAt, fetchError, target, head, missing: `${empty.repo}'s clone has no ${target} to compare with` };
    }

    let base: string | undefined;
    let merged: BranchView['merged'] = null;
    const isMerged = (await gitAsync(clone, ['merge-base', '--is-ancestor', head, tip])).code === 0;
    if (isMerged && head !== tip) {
      const merges = (await out(clone, ['rev-list', '--ancestry-path', '--merges', '--reverse', '--parents', `${head}..${tip}`])) ?? '';
      // `<merge> <first parent> <other parents…>`: the merge that took the head in.
      const line = merges.split(/\r?\n/).find((l) => l.split(' ').slice(2).includes(head));
      const [sha, firstParent] = line?.split(' ') ?? [];
      if (sha !== undefined && firstParent !== undefined) {
        const [at = '0', subject = ''] = ((await out(clone, ['show', '-s', '--format=%ct%x1f%s', sha])) ?? '').split('\x1f');
        merged = { sha, at: Number(at), pr: prOf(subject) };
        base = await out(clone, ['merge-base', firstParent, head]);
      } else {
        // Fast-forwarded in: where it left the default branch is not recorded anywhere.
        merged = { sha: head, at: 0, pr: null };
        base = head;
      }
    } else {
      base = await out(clone, ['merge-base', tip, head]);
    }
    if (base === undefined) {
      return { ...empty, fetchedAt, fetchError, target, head, missing: `${branch} shares no history with ${target}` };
    }

    const [ahead, behind, log, nameStatus, numstat] = await Promise.all([
      out(clone, ['rev-list', '--count', `${base}..${head}`]),
      out(clone, ['rev-list', '--count', `${head}..${tip}`]),
      out(clone, ['log', '-n', '300', '--format=%H%x1f%ct%x1f%an%x1f%s', `${base}..${head}`]),
      gitAsync(clone, ['diff', '--no-ext-diff', '-M', '--name-status', '-z', base, head]),
      gitAsync(clone, ['diff', '--no-ext-diff', '-M', '--numstat', '-z', base, head]),
    ]);
    const commits = (log ?? '')
      .split(/\r?\n/)
      .filter((l) => l !== '')
      .map((l) => {
        const [sha = '', at = '0', author = '', subject = ''] = l.split('\x1f');
        return { sha, at: Number(at), author, subject };
      });

    return {
      ...empty,
      missing: null,
      fetchedAt,
      fetchError,
      target,
      base,
      head,
      merged,
      ahead: Number(ahead ?? 0),
      behind: merged === null ? Number(behind ?? 0) : 0,
      links: {
        ...empty.links,
        pr: github !== null && merged?.pr != null ? `${github}/pull/${merged.pr}` : null,
        compare: github !== null && merged === null ? `${github}/compare/${target}...${branch}` : null,
      },
      commits,
      files: changedFiles(nameStatus.stdout, numstat.stdout),
    };
  }

  private targetOf(clone: string): string {
    let t = this.targets.get(clone);
    if (t === undefined) {
      t = defaultBranch(clone) ?? 'main';
      this.targets.set(clone, t);
    }
    return t;
  }

  /**
   * Fetch the branches into the server's own refs, at most once per `everyS`
   * for the same branches of a clone. A branch origin no longer has (deleted
   * after its merge, most often) keeps the copy fetched before, and is not
   * an error.
   */
  private async fetch(clone: string, branches: readonly string[], force = false): Promise<void> {
    const now = Date.now() / 1000;
    const key = fetchKey(clone, branches);
    const state = this.fetched.get(key);
    if (state?.running !== undefined) return state.running;
    if (!force && state !== undefined && now - state.at < this.everyS) return undefined;

    const running = (async (): Promise<void> => {
      const fetchOf = (names: readonly string[]): Promise<ProcessResult> =>
        gitAsync(
          clone,
          ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', '--no-write-fetch-head', '--no-tags', '--quiet', 'origin', ...names.map((b) => `+refs/heads/${b}:${OWN}${b}`)],
          30_000,
        );
      const gone = (r: ProcessResult): boolean => /couldn't find remote ref/i.test(r.stderr);
      const lastLine = (r: ProcessResult): string => r.stderr.trim().split(/\r?\n/).pop() || 'fetch failed';
      // One connection for all of them; only when one is gone from origin, one at a time.
      let error: string | null = null;
      const all = await fetchOf(branches);
      if (all.code !== 0 && gone(all)) {
        for (const b of branches) {
          const r = await fetchOf([b]);
          if (r.code !== 0 && !gone(r)) error = lastLine(r);
        }
      } else if (all.code !== 0) {
        error = lastLine(all);
      }
      this.fetched.set(key, { at: Math.floor(Date.now() / 1000), error });
    })();
    this.fetched.set(key, { at: state?.at ?? 0, error: state?.error ?? null, running });
    return running;
  }
}
