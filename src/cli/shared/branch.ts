import { branchExists, commitTree, createBranch, fetch, gitLines, gitOk, mergeTree, push, revParse, updateRef } from '../../util/git.js';
import { YanError } from '../../util/error.js';

/**
 * The git side of a unit's integration branch: naming it, making it exist,
 * and carrying a replaced round's work onto the next. A unit's branch is
 * named one of two ways:
 *
 *   default   yan names it `yan/<task>-<unit>-r<n>`
 *   --branch  you name it, in whatever spelling your tooling printed
 *
 * Either way yan makes it exist, adopting a local or remote branch of that
 * name before cutting one. Everything it cuts is a ref, never a checkout, so
 * whoever is working in the main clone stays on their branch.
 */

/** What the built-in name is made of. */
export interface BranchNameContext {
  readonly task: string;
  readonly unit: string;
  readonly round: number;
}

export type NameSource = 'user' | 'default';

/** `given` normalised when there is one, otherwise the built-in name. */
export function decideBranchName(
  given: string | undefined,
  context: BranchNameContext,
): { branch: string; from: NameSource; raw?: string } {
  if (given !== undefined && given !== '') {
    return { branch: normalizeBranchName(given), from: 'user', raw: given };
  }
  return { branch: `yan/${context.task}-${context.unit}-r${context.round}`, from: 'default' };
}

/**
 * A branch name as a tool may have printed it — `refs/heads/x`, `origin/x`,
 * quoted, or with a trailing CR — reduced to the plain name.
 */
export function normalizeBranchName(raw: string): string {
  let name = raw.trim().replace(/\r/g, '');
  if ((name.startsWith('"') && name.endsWith('"')) || (name.startsWith("'") && name.endsWith("'"))) {
    name = name.slice(1, -1).trim();
  }
  name = name.replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  return name.trim();
}

/**
 * @throws YanError `<command>_usage` when `branch` is unusable as a git ref. The
 *   message quotes `raw` too, so a hook's own output is recognisable.
 */
export function checkRefName(command: string, branch: string, raw?: string): void {
  const bad = branch === '' || /\s/.test(branch) || branch.startsWith('-') || branch.endsWith('/');
  if (bad) {
    const from = raw !== undefined && raw !== branch ? ` (from '${raw}')` : '';
    throw YanError.usage(`${command}_usage`, `'${branch}'${from} is not usable as a git ref - fix the hook, or pass --branch`,
    );
  }
}

/**
 * `origin/<branch>` when it resolves, otherwise `''`. Preferred over a local
 * ref of the same name, which a main clone never pulls into.
 */
export function remoteRef(clone: string, branch: string): string {
  return gitOk(clone, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
    ? `origin/${branch}`
    : '';
}

/**
 * Bring a main clone's `origin/*` refs up to date. Warns rather than throwing
 * when the network is not there. Call it once per clone: nothing below
 * fetches.
 */
export function freshenClone(command: string, clone: string, repo: string): void {
  if (fetch(clone).code !== 0) {
    process.stderr.write(`${command}: could not fetch ${repo} - working from the refs already in the clone\n`);
  }
}

/**
 * Make `branch` exist in the clone as a ref, adopting a local or remote one of
 * that name before cutting a new one from `base`. Returns a line saying which
 * happened. Never fetches and never checks anything out.
 *
 * @throws YanError `<command>_branch_failed` or `<command>_base_unresolved`.
 */
export function ensureBranch(command: string, clone: string, branch: string, base: string): string {
  if (branchExists(clone, branch)) return 'adopted the existing local branch';

  if (remoteRef(clone, branch) !== '') {
    if (createBranch(clone, branch, `origin/${branch}`).code !== 0) {
      throw new YanError(`${command}_branch_failed`, `cannot create a local ref for the existing remote branch '${branch}'`,
      );
    }
    return `adopted origin/${branch}`;
  }

  let baseRef = remoteRef(clone, base);
  if (baseRef === '') {
    if (branchExists(clone, base)) baseRef = base;
    else if (gitOk(clone, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])) baseRef = base;
    else {
      throw new YanError(`${command}_base_unresolved`, `cannot resolve the base '${base}' in ${clone} - fetch it, or pass --base with something that exists`,
      );
    }
  }
  if (createBranch(clone, branch, baseRef).code !== 0) {
    throw new YanError(`${command}_branch_failed`, `cannot cut '${branch}' from '${baseRef}' in ${clone}`);
  }
  return `cut from ${baseRef}`;
}

export interface Inherited {
  /** What happened, in one line, for the caller to print and to log. */
  readonly said: string;
  /** True when commits were carried forward and the branch moved. */
  readonly moved: boolean;
  /** Paths git could not merge. Non-empty means nothing was carried. */
  readonly conflicts: readonly string[];
}

/**
 * Merge the round being replaced onto the new integration branch, and push it.
 *
 * Runs entirely in the main clone: `merge-tree --write-tree` writes objects
 * and refs and never checks anything out, so no tree is leased and nothing is
 * left half-done. Never throws — a conflict, a failed commit or a failed push
 * all come back in `said`, with `moved` false.
 */
export function inheritRound(clone: string, from: string, to: string): Inherited {
  if (!branchExists(clone, from) || !branchExists(clone, to)) {
    return { said: 'nothing was carried forward: one of the two branches is not in this clone', moved: false, conflicts: [] };
  }

  const ahead = gitLines(clone, ['rev-list', '--count', `${to}..${from}`]).join('').trim();
  if (ahead === '' || ahead === '0') {
    return { said: `nothing to carry forward: ${to} already has everything on ${from}`, moved: false, conflicts: [] };
  }

  const merged = mergeTree(clone, to, from);
  if (merged.code !== 0) {
    const conflicts = [
      ...new Set(
        merged.stdout
          .split(/\r?\n/)
          .map((l) => /^(?:CONFLICT|Auto-merging)[^)]*\)?\s*(.*)$/.exec(l.trim())?.[1] ?? '')
          .filter((p) => p !== ''),
      ),
    ];
    return {
      said: `${ahead} commit(s) on ${from} did NOT carry forward: they conflict with ${to}`,
      moved: false,
      conflicts,
    };
  }

  const tree = merged.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  const ours = revParse(clone, [to]);
  const theirs = revParse(clone, [from]);
  const commit = commitTree(clone, tree, [ours, theirs], `carry ${from} forward onto ${to}`);
  if (commit.code !== 0 || commit.stdout.trim() === '') {
    return { said: `could not commit the carried work: ${commit.stderr.trim()}`, moved: false, conflicts: [] };
  }
  const moved = updateRef(clone, `refs/heads/${to}`, commit.stdout.trim(), ours);
  if (moved.code !== 0) {
    return { said: `could not move ${to} onto the carried work: ${moved.stderr.trim()}`, moved: false, conflicts: [] };
  }

  const pushed = push(clone, ['origin', to]);
  return {
    said:
      pushed.code === 0
        ? `carried ${ahead} commit(s) from ${from} onto ${to}, and pushed`
        : `carried ${ahead} commit(s) from ${from} onto ${to}, but the push failed: ${pushed.stderr.trim()}`,
    moved: true,
    conflicts: [],
  };
}
