import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { CommandError } from './shared/errors.js';
import { poolSize, repoTarget } from './shared/repo.js';
import { WorktreePool, WorktreeError } from '../externals/worktree/index.js';
import { Task } from '../records/task/index.js';
import { diffNameOnly, fetch, git, gitOk, merge, push, rebase, resetHard, revParse } from '../util/git.js';

/**
 * `yan sync` — bring a unit's integration branch up to date with its target
 * (branching.md §6.3, worktree.md §7, architecture.md §5.2).
 *
 *     lease a tree → fetch → rebase or merge target → push → return the tree
 *
 * THIS IS A SCRIPT ACTION, NOT A SHIFT. No agent is involved, and catching up
 * with `target` must never be handed to a shift branch's agent: that agent sees
 * only its own small change, and asking it to rebase the whole integration
 * branch is a disaster. Its timing is fixed — sync before starting each new
 * shift — so the new shift branch comes off a head that has just caught up, and
 * conflicts stay in ONE place, the integration branch against target, instead
 * of being scattered across every shift branch to be solved again and again.
 *
 * TWO THINGS THIS COMMAND WILL NOT DO.
 *
 *   1. IT NEVER RESOLVES A CONFLICT. On a conflict it undoes what it started,
 *      returns the tree, prints the conflicting paths and exits 5. Resolving is
 *      a shift's job (boundaries.md §9.3). The script's one entry into a
 *      worktree is this command, and it leaves as soon as the work stops being
 *      mechanical.
 *
 *      Why it aborts and hands the tree back instead of parking the conflict in
 *      the leased tree for a shift to pick up: a tree with an unresolved merge
 *      in it is dirty, the pool's orphan-commit guard refuses to take a dirty
 *      tree back, and there is deliberately no override for that refusal
 *      anywhere. Leaving it would take a slot out of the pool with no way to
 *      recover it. Nothing is lost by aborting — the same merge conflicts again
 *      the moment the shift runs it.
 *
 *   2. IT NEVER FORCE-PUSHES (boundaries.md §9.2), which is also why the
 *      default strategy is `merge`. Rebasing an integration branch that has
 *      already been pushed rewrites published history, and the only way to
 *      publish that is a force push. `--strategy rebase` stays available for a
 *      branch that has not been published yet; when the push is then rejected,
 *      this command says so and stops rather than reaching for -f.
 *
 * THE POOL-FULL TRAP (worktree.md §7, called out there by name). sync takes a
 * short lease, and sync is the first step of `yan shift new`. When the pool is
 * full the lease fails — and the error has to say "the pool is full, cannot
 * start a new shift", NOT "sync failed", or the reader goes hunting for a
 * synchronisation problem that does not exist.
 *
 * Exit codes: 0 fine, 2 you called this wrongly, 3 the pool is full, 5 a
 * conflict needs a shift, 1 anything else.
 */

const RC_POOL_FULL = 3;
const RC_CONFLICT = 5;

export interface SyncOptions {
  task?: string;
  unit?: string;
  strategy?: string;
  json?: boolean;
}

/** What this command settled, for a caller that wants it rather than the text. */
export interface SyncResult {
  readonly task: string;
  readonly unit: string;
  readonly branch: string;
  readonly target: string;
  readonly strategy: 'merge' | 'rebase';
  readonly before: string;
  readonly after: string;
  readonly moved: boolean;
}

function resolves(tree: string, ref: string): boolean {
  return gitOk(tree, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/**
 * The command without the process around it, so `shift new` can make sync its
 * first step by calling it rather than by shelling out to itself.
 */
export function sync(options: SyncOptions): SyncResult {
  const task = options.task ?? '';
  const unitName = options.unit ?? '';
  const strategy = options.strategy ?? 'merge';

  if (task === '') throw CommandError.usage('sync', '--task is required');
  if (unitName === '') throw CommandError.usage('sync', '--unit is required');
  if (strategy !== 'merge' && strategy !== 'rebase') {
    throw CommandError.usage('sync', `--strategy is 'merge' or 'rebase', not '${strategy}'`);
  }

  if (!Task.exists(task)) throw CommandError.usage('sync', `no such task: ${task}`);
  const unit = new Task(task).findUnit(unitName);
  if (unit === undefined) throw CommandError.usage('sync', `no such unit: ${unitName} in ${task}`);

  const data = unit.read();
  if (data.branch === '') {
    throw CommandError.usage('sync', `unit ${unitName} has no integration branch yet - 'yan unit add' or 'yan unit set --branch' sets one`,
    );
  }
  if (data.target === '') {
    throw CommandError.usage('sync', `unit ${unitName} has no target - 'yan unit set --target' sets one`);
  }

  const { clone, key } = repoTarget('sync', data.repo, 'the unit names it, but there is no clone under repos/');
  const pool = new WorktreePool(clone);
  const holder = `${task}/${unitName}/sync`;

  let grant;
  try {
    grant = pool.get(poolSize(key), data.branch, data.branch, holder);
  } catch (err) {
    // THE POOL-FULL TRAP. Same failure, completely different thing to go and
    // look at, so it gets its own sentence and its own exit code. The shell
    // half had to recognise this by matching lib-pool's own wording; the pool
    // module names the condition instead, which is what a closed error code is
    // for.
    if (err instanceof WorktreeError && err.code === WorktreeError.codes.full) {
      throw new CommandError('sync', 'pool_full', `the pool is full, cannot start a new shift - every tree is leased, so there is nowhere to sync ${data.branch}. This is not a synchronisation problem. Run 'yan tree status --repo ${data.repo}' to see who holds them; a shift has to finish before another can start.`,
        { exitCode: RC_POOL_FULL, cause: err },
      );
    }
    throw err;
  }

  const tree = grant.path;
  const before = revParse(tree, ['HEAD']);
  let pushed = false;

  // The lease is short and it is always given back — including on the conflict
  // path. Anything this command committed but did not manage to push is undone
  // first: it exists nowhere else, it is mechanical, and re-running produces it
  // again. That also keeps the orphan-commit guard from having to refuse the
  // return and taking a slot out of the pool with it.
  const release = (): void => {
    git(tree, ['merge', '--abort']);
    git(tree, ['rebase', '--abort']);
    if (!pushed) resetHard(tree, before);
    try {
      pool.return(tree, { leaseId: grant.lease_id, holder });
    } catch {
      process.stderr.write(`yan sync: the tree at ${tree} could not be returned - 'yan tree status --repo ${data.repo}' shows the lease; investigate before it is leased again\n`,
      );
    }
  };

  try {
    if (fetch(tree).code !== 0) {
      throw new CommandError('sync', 'fetch_failed', "cannot fetch from origin - a sync without the remote's current state would be a lie",
      );
    }

    // Catch up with our own branch first. Other shifts merge into the
    // integration branch through the host, so origin/<branch> can be ahead of
    // the leased tree; without this the push at the end would simply be
    // rejected.
    if (resolves(tree, `refs/remotes/origin/${data.branch}`)) {
      if (merge(tree, [`origin/${data.branch}`, '--ff-only']).code !== 0) {
        process.stderr.write(`yan sync: ${data.branch} and origin/${data.branch} have diverged, so this is not a fast-forward\n`,
        );
        throw new CommandError('sync', 'diverged', 'the local integration branch cannot catch up with its own remote without rewriting history - dispatch a shift to reconcile them',
          { exitCode: RC_CONFLICT },
        );
      }
    }

    let targetRef = '';
    if (resolves(tree, `refs/remotes/origin/${data.target}`)) targetRef = `origin/${data.target}`;
    else if (resolves(tree, data.target)) targetRef = data.target;
    else {
      throw new CommandError('sync', 'target_unresolved', `cannot resolve the target '${data.target}' in the leased tree - does the branch still exist on the remote?`,
      );
    }

    const handOff = (what: string): never => {
      const paths = diffNameOnly(tree, ['--diff-filter=U']);
      process.stderr.write(`yan sync: ${data.branch} conflicts with ${targetRef}\n`);
      if (paths.length > 0) {
        process.stderr.write('yan sync: conflicting paths:\n');
        for (const p of paths) process.stderr.write(`  ${p}\n`);
      }
      throw new CommandError('sync', 'conflict', `${what} stopped on a conflict, and yan does not resolve conflicts - dispatch a shift to reconcile ${data.branch} with ${targetRef}. The merge is undone, the tree goes back to the pool, and nothing was pushed.`,
        { exitCode: RC_CONFLICT },
      );
    };

    if (strategy === 'rebase') {
      if (rebase(tree, [targetRef]).code !== 0) handOff('the rebase');
    } else if (merge(tree, [targetRef, '--no-edit']).code !== 0) {
      handOff('the merge');
    }

    const after = revParse(tree, ['HEAD']);

    // Pushing the integration branch after a sync is yan's own authority
    // (boundaries.md §9.2). Never with force, and util/git refuses one anyway.
    const pushResult = push(tree, ['origin', data.branch]);
    if (pushResult.code !== 0) {
      process.stderr.write(`${pushResult.stdout}${pushResult.stderr}`);
      throw new CommandError('sync', 'push_failed', `cannot push ${data.branch} - if it was rejected as non-fast-forward, someone else has moved it; re-run the sync. yan never force-pushes.`,
      );
    }
    pushed = true;

    return {
      task,
      unit: unitName,
      branch: data.branch,
      target: targetRef,
      strategy,
      before,
      after,
      moved: before !== after,
    };
  } finally {
    release();
  }
}

export const command = new Command('sync')
  .description("bring a unit's integration branch up to date with its target")
  .option('--task <id>', 'the task the unit belongs to')
  .option('--unit <name>', 'the unit name')
  .option('--strategy <how>', 'merge (default) or rebase')
  .option('--json', 'machine readable output')
  .addHelpText(
    'after',
    `
usage: yan sync --task <id> --unit <name> [--strategy merge|rebase] [--json]

Leases a tree for a moment, fetches, brings the unit's integration branch up
to date with its target, pushes it, and gives the tree back.

  --strategy  merge (default) or rebase. merge is the default because a
              published integration branch can only be rebased by rewriting
              history, and force-pushing is forbidden (boundaries.md §9.2).

On a conflict this command aborts what it started, returns the tree, prints
the conflicting paths and exits 5. It never resolves a conflict: that is a
shift's job (branching.md §6.3).

When the pool is full the lease fails and this command says so as what it is -
the pool is full, no new shift can start - not as a synchronisation failure.`,
  )
  .action(
    action('yan sync', (options: SyncOptions) => {
      const r = sync(options);
      if (options.json === true) {
        out(JSON.stringify(r));
      } else if (r.moved) {
        out(`${r.unit}  ${r.branch} caught up with ${r.target} by ${r.strategy} (${r.before.slice(0, 8)} → ${r.after.slice(0, 8)}) and was pushed`,
        );
      } else {
        out(`${r.unit}  ${r.branch} is already up to date with ${r.target}`);
      }
    }),
  );
