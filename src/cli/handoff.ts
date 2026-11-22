import { copyFileSync, cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { Command } from 'commander';
import { action, collect, out } from './shared/action.js';
import { takenAnywhere } from './shared/launch.js';
import { workspacePackages } from './shared/packages.js';
import { plainChain } from './shared/plain-chain.js';
import { tasksEverywhere, workIn } from './shared/task-id.js';
import { saveVault } from './shared/vault-push.js';
import { herdrBin, openYanTab } from './shared/yan-tab.js';
import { repoNamed } from '../records/repos/index.js';
import { Task, type TaskRepo } from '../records/task/index.js';
import { YanError, isYanError } from '../util/error.js';
import { gitOk } from '../util/git.js';
import { isDirectory } from '../util/paths.js';
import { everyVault, vaultDir } from '../util/vault.js';

/**
 * `yan handoff` — a matter handed over to a task of its own, as Janus
 * hands one over (yan:handoff): the task is made here, so its id is known
 * at once, with the handoff written for it as its problem.md and whatever
 * files it should carry in its artifacts/; then its agent is started in a
 * herdr tab of its own, as the page starts one, in the task's worktrees.
 * That agent is given nothing to begin on: it is there for `user` to take
 * up. A tab that cannot be opened leaves the task made, and says how to
 * start it.
 */

interface HandoffOptions {
  problem?: string;
  repo?: string[];
  vault?: string;
  artifact?: string[];
  start: boolean;
  json?: boolean;
}

/** `name` or `name:package,package`, as bare `yan`'s `--repo` takes it, as the repository the task works in. */
function taskRepo(spec: string): TaskRepo {
  const colon = spec.indexOf(':');
  const name = (colon < 0 ? spec : spec.slice(0, colon)).trim();
  const scope = colon < 0 ? [] : spec.slice(colon + 1).split(',').map((p) => p.trim()).filter((p) => p !== '');
  const repo = repoNamed(name);
  if (repo === undefined) throw YanError.usage('handoff_usage', `no repository called ${name} is registered - 'yan repo ls' lists those that are`);
  if (scope.length > 0) {
    const packages = repo.clone !== undefined && isDirectory(repo.clone) ? workspacePackages(repo.clone) : [];
    const unknown = scope.filter((p) => !packages.includes(p));
    if (unknown.length > 0) throw YanError.usage('handoff_usage', `${name} has no package ${unknown.join(', ')}${packages.length === 0 ? '' : `; it has ${packages.join(', ')}`}`);
  }
  return { url: repo.url, ...(scope.length === 0 ? {} : { scope }) };
}

export const command = new Command('handoff')
  .description('make a task of a matter and start its agent in a tab of its own, waiting: the handoff file becomes its problem.md; Janus\'s to run, once the user agreed the scope')
  .argument('<title>', 'the new task\'s title, on one line')
  .option('--problem <file>', 'the handoff, written for an agent that starts from nothing: it becomes the task\'s problem.md')
  .option('--repo <name[:package,...]>', 'a repository the task works in, by its registered name, with the packages it is about after a colon; repeat for several, none for a task with no worktree', collect)
  .option('--vault <name>', 'the vault the task is kept in, on a machine with several; the first, the default, without it')
  .option('--artifact <path>', 'a file or folder the task should carry, copied into its artifacts/; repeat for several', collect)
  .option('--no-start', 'make the task and start no agent on it')
  .option('--json', 'what was made, as JSON: { id, title, vault, dir, started }')
  .action(
    action('yan handoff', async (title: string, options: HandoffOptions) => {
      if (options.problem === undefined) throw YanError.usage('handoff_usage', 'a handoff needs what the task starts from: pass --problem <file>');
      const problem = resolve(options.problem);
      if (!existsSync(problem) || !statSync(problem).isFile()) throw YanError.usage('handoff_usage', `no such file: ${options.problem}`);
      const artifacts = (options.artifact ?? []).map((a) => resolve(a));
      for (const a of artifacts) if (!existsSync(a)) throw YanError.usage('handoff_usage', `no such file or folder: ${a}`);

      // Read before the process is pointed at one vault, after which it sees only that one's.
      const everywhere = tasksEverywhere().map((t) => t.id);
      if (options.vault !== undefined) {
        const named = everyVault().find((v) => v.name === options.vault);
        if (named === undefined) throw YanError.usage('handoff_usage', `no vault called ${options.vault} is registered here - 'yan vault ls' lists them`);
        workIn(named.dir);
      } else workIn(everyVault()[0]?.dir ?? vaultDir());
      const vault = vaultDir();
      const repos = (options.repo ?? []).map(taskRepo);

      const task = Task.create(title, repos, await takenAnywhere(plainChain, everywhere));
      copyFileSync(problem, task.problem);
      if (artifacts.length > 0) mkdirSync(join(task.dir, 'artifacts'), { recursive: true });
      for (const a of artifacts) cpSync(a, join(task.dir, 'artifacts', basename(a)), { recursive: true });
      if (gitOk(vault, ['rev-parse', '--is-inside-work-tree'])) {
        try {
          saveVault(vault, `${task.id}: handed over as a task`);
        } catch (err) {
          process.stderr.write(`vault: ${task.id} not pushed yet - its agent's first turn pushes it (${err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)})\n`);
        }
      }

      const name = task.read().title;
      let started = false;
      let why = '';
      if (options.start) {
        try {
          // The trees are opened unasked: nobody is at the tab to say yes.
          await openYanTab(herdrBin(vault), vault, name, ['--task', task.id, '--trees']);
          started = true;
        } catch (err) {
          if (!isYanError(err)) throw err;
          why = err.message;
        }
      }
      if (options.json === true) return out(JSON.stringify({ id: task.id, title: name, vault, dir: task.dir, started }, null, 2));
      out(`${task.id}  ${name}`);
      if (started) out('its agent is starting in a tab of its own, and waits there for the user');
      else if (options.start) out(`no agent started: ${why} - 'yan --task ${task.id}' starts one`);
      else out(`no agent started - 'yan --task ${task.id}' starts one`);
    }),
  );
