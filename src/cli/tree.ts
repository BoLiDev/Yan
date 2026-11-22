import { Command } from 'commander';
import { action, out } from './shared/action.js';
import { leaseTree } from './shared/launch.js';
import { plainChain } from './shared/plain-chain.js';
import { repoName } from './shared/repo-name.js';
import { requiredTask } from './shared/task-id.js';
import { leasesHeldBy, returnTrees } from '../externals/worktree/index.js';
import { registry, repoNamed } from '../records/repos/index.js';
import { JANUS, type Task } from '../records/task/index.js';
import { YanError } from '../util/error.js';
import { branchOf, remoteUrl } from '../util/git.js';
import { isDirectory } from '../util/paths.js';
import { repoKey } from '../util/repo-key.js';

/**
 * `yan tree` — the worktrees Janus takes and gives back by hand. A task's
 * trees are opened as its agent is started, one for each repository it
 * works in, and given back as it is paused or closed; Janus works in no
 * repository of its own, so it takes one of any registered repository when
 * it has something to change or run there, and gives it back once done.
 * Leased from the same pool, under Janus's id, so a tree it holds is
 * nobody else's and survives its session.
 */

/** Janus's task, which these commands are for alone. */
function janus(): Task {
  const task = requiredTask(undefined, '$YAN_TASK');
  if (task.id !== JANUS) {
    throw YanError.usage('tree_usage', `${task.id}'s worktrees are opened as its agent is started and given back as it is paused or closed - only Janus takes and returns them by hand`);
  }
  return task;
}

interface Held {
  readonly name: string;
  readonly path: string;
}

/** The trees Janus holds, each named for its repository as registered, else by its URL. */
function held(): Held[] {
  const known = registry();
  return leasesHeldBy(JANUS).map((l) => {
    const url = remoteUrl(l.path) ?? '';
    const name = known.find((r) => repoKey(r.url) === repoKey(url))?.name ?? repoName(url);
    return { name, path: l.path };
  });
}

const get = new Command('get')
  .description('take a worktree of a registered repository, on a detached HEAD at origin\'s default branch, and print where it is; the one already held, when there is one')
  .argument('<repo>', 'the repository, by its registered name')
  .action(
    action('yan tree get', async (name: string) => {
      const task = janus();
      const mine = held().find((h) => h.name === name);
      if (mine !== undefined) {
        process.stderr.write(`${name}: already held, on ${branchOf(mine.path) ?? 'a detached HEAD'}\n`);
        out(mine.path);
        return;
      }
      const repo = repoNamed(name);
      if (repo === undefined) throw YanError.usage('tree_usage', `no repository called ${name} is registered - 'yan repo ls' lists those that are`);
      if (repo.clone === undefined || !isDirectory(repo.clone)) throw YanError.usage('tree_usage', `${name} has no clone on this machine - 'yan repo add' where it is cloned`);
      out(await leaseTree(task, { name, clone: repo.clone, scope: [] }, plainChain));
    }),
  );

const ls = new Command('ls')
  .description('the worktrees Janus holds: each repository, where its tree is, and what it is on')
  .option('--json', 'the same as JSON')
  .action(
    action('yan tree ls', (options: { json?: boolean }) => {
      janus();
      const rows = held().map((h) => ({ repo: h.name, path: h.path, branch: branchOf(h.path) ?? null }));
      if (options.json === true) return out(JSON.stringify(rows, null, 2));
      if (rows.length === 0) return out('no worktree held - \'yan tree get <repo>\' takes one');
      for (const r of rows) out(`${r.repo}  ${r.path}  ${r.branch ?? 'detached HEAD'}`);
    }),
  );

const give = new Command('return')
  .description('give a worktree back to the pool, which resets and cleans it: refused while it holds uncommitted changes or commits no remote branch has, unless --force')
  .argument('[repo]', 'the repository whose tree to give back')
  .option('--all', 'every tree held')
  .option('--force', 'throw away what the tree holds that exists nowhere else')
  .action(
    action('yan tree return', (name: string | undefined, options: { all?: boolean; force?: boolean }) => {
      janus();
      const mine = held();
      if (name === undefined && options.all !== true) throw YanError.usage('tree_usage', 'which tree? name its repository, or pass --all');
      const going = name === undefined ? mine : mine.filter((h) => h.name === name);
      if (name !== undefined && going.length === 0) throw YanError.usage('tree_usage', `no worktree of ${name} is held - 'yan tree ls' lists those that are`);
      for (const h of going) {
        returnTrees(JANUS, { only: h.path, ...(options.force === true ? { force: true } : {}) });
        out(`${h.name}  returned`);
      }
      if (going.length === 0) out('no worktree held');
    }),
  );

export const command = new Command('tree')
  .description('Janus\'s worktrees, taken and given back by hand: get <repo>, ls, return <repo>')
  .addCommand(get)
  .addCommand(ls)
  .addCommand(give);
