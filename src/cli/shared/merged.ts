import { git } from '../../util/git.js';

/**
 * Whether a branch was merged into origin's default branch, as git tells
 * it: a merge commit on the default branch took the branch's head in. One
 * fast-forwarded in is not told apart from one just cut and not committed
 * to yet, both a commit the default branch already has, so neither counts.
 * `yan serve` reads the same through its own refs (`serve/branch-view.ts`).
 */

/** What lists the merges after `head` up to `tip`, each with its parents. */
export function takingArgs(head: string, tip: string): string[] {
  return ['rev-list', '--ancestry-path', '--merges', '--reverse', '--parents', `${head}..${tip}`];
}

/**
 * The merge that took `head` in, from what `takingArgs` lists: the first
 * that has it as a parent other than the first.
 */
export function mergeTaking(listed: string, head: string): { sha: string; firstParent: string } | undefined {
  // `<merge> <first parent> <other parents…>`
  const line = listed.split(/\r?\n/).find((l) => l.split(' ').slice(2).includes(head));
  const [sha, firstParent] = line?.split(' ') ?? [];
  return sha === undefined || firstParent === undefined ? undefined : { sha, firstParent };
}

/** What lists the merges on `tip` whose message names `branch`, newest first. */
export function namingArgs(tip: string, branch: string): string[] {
  return ['log', tip, '--merges', '--fixed-strings', `--grep=${branch}`, '-n', '50', '--format=%P%x1f%s'];
}

/**
 * The head `branch` had when a merge took it in, from what `namingArgs`
 * lists, for a branch deleted from origin before the clone had it: GitHub's
 * `Merge pull request #N from <owner>/<branch>`, or git's own `Merge branch
 * '<branch>'`. The newest such merge wins.
 */
export function namedMergeHead(listed: string, branch: string): string | undefined {
  for (const line of listed.split(/\r?\n/)) {
    const [parents = '', subject = ''] = line.split('\x1f');
    const names = subject.endsWith(`/${branch}`) || subject.endsWith(` ${branch}`) || subject.includes(`'${branch}'`);
    const second = parents.split(' ')[1];
    if (names && second !== undefined && second !== '') return second;
  }
  return undefined;
}

function sha(dir: string, refs: readonly string[]): string | undefined {
  for (const ref of refs) {
    const r = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (r.code === 0 && r.stdout.trim() !== '') return r.stdout.trim();
  }
  return undefined;
}

/**
 * Whether `branch` was merged into `target`, from the refs of the clone or
 * tree `dir`, as last fetched: origin's copy of the branch, else the local
 * one, else a merge that names it.
 */
export function mergedInto(dir: string, branch: string, target: string): boolean {
  const tip = sha(dir, [`refs/remotes/origin/${target}`, `refs/heads/${target}`]);
  if (tip === undefined) return false;
  const head = sha(dir, [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]);
  if (head === undefined) {
    const named = git(dir, namingArgs(tip, branch));
    return named.code === 0 && namedMergeHead(named.stdout, branch) !== undefined;
  }
  if (head === tip || git(dir, ['merge-base', '--is-ancestor', head, tip]).code !== 0) return false;
  const listed = git(dir, takingArgs(head, tip));
  return listed.code === 0 && mergeTaking(listed.stdout, head) !== undefined;
}
