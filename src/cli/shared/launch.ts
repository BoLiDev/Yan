import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { out } from './action.js';
import { openTasks } from './task-id.js';
import { repoKey } from './repo-key.js';
import { CREATE_NEW, type TaskChoice } from '../../ui/prompts.js';

export { CREATE_NEW };
import { tildePath } from './style.js';
import { cliKind, HARNESS_KINDS, isKnownCli, launchArgs } from '../../externals/harness/index.js';
import { WorktreePool, leaseHeldBy } from '../../externals/worktree/index.js';
import { Task } from '../../records/task/index.js';
import { YanError } from '../../util/error.js';
import { defaultBranch, fetch, git, gitOk, remoteUrl } from '../../util/git.js';
import { asString } from '../../util/narrow.js';
import { normalizePath } from '../../util/paths.js';
import { readVaultConfig, readVaultJson, vaultConfigPath, vaultDir } from '../../util/vault.js';

/**
 * Bare `yan`: pick a task or start one, then start the agent on it in this
 * terminal, in the task's tree when it has one.
 *
 * The agent is told as little as will let it find the rest: that a CLI keeps
 * notes on this work, and the two commands that read them. Which task it is
 * travels in `$YAN_TASK`, which every command reads, so the agent never needs
 * the id.
 */

/** What the agent is told before `user` says anything. */
export const OPENING_PROMPT = [
  'Notes from earlier sessions on this work are kept by a CLI.',
  '`yan peek` shows what the work is about; `yan log` shows what was settled. `yan --help` for the rest.',
].join('\n');

/** The harness `config.json` names, or claude with its own defaults. */
interface HarnessConfig {
  readonly cli: string;
  readonly model: string;
  readonly effort: string;
}

function harnessConfig(override: string | undefined): HarnessConfig {
  const raw = readVaultConfig() ?? {};
  const configured = {
    cli: asString(raw.cli).trim() || 'claude',
    model: asString(raw.model).trim(),
    effort: asString(raw.effort).trim(),
  };
  // A model chosen for the configured CLI means nothing to another one.
  const chosen = override === undefined || override === '' || override === configured.cli
    ? configured
    : { cli: override, model: '', effort: '' };
  if (!isKnownCli(chosen.cli)) {
    throw YanError.usage('yan_usage', `'${chosen.cli}' is not a CLI yan can start - one of: ${HARNESS_KINDS.join(' ')} (set "cli" in ${vaultConfigPath()})`);
  }
  return chosen;
}

/**
 * The main clone of the repository `dir` is in — the clone itself when `dir`
 * is a worktree of it — or `undefined` outside a repository.
 */
function mainClone(dir: string): string | undefined {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (common.code !== 0) return undefined;
  return normalizePath(dirname(common.stdout.trim()));
}

/**
 * Lease `task` a tree of `clone` on `yan/<id>`. The branch is cut from
 * origin's default branch, or picked up from origin when another machine
 * already pushed it.
 */
function leaseTree(task: Task, clone: string): string {
  const branch = `yan/${task.id}`;
  out(`fetching ${remoteUrl(clone) ?? 'origin'} …`);
  const fetched = fetch(clone);
  if (fetched.code !== 0) process.stderr.write(`yan: could not fetch, cutting from what the clone has - ${fetched.stderr.trim()}\n`);

  const has = (ref: string): boolean => gitOk(clone, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  let base: string;
  if (has(`refs/remotes/origin/${branch}`)) {
    base = `origin/${branch}`;
  } else {
    const trunk = defaultBranch(clone);
    if (trunk === undefined) throw new YanError('yan_no_base', `cannot tell ${clone}'s default branch - set it with 'git -C ${clone} remote set-head origin --auto'`);
    base = has(`refs/remotes/origin/${trunk}`) ? `origin/${trunk}` : trunk;
  }
  return new WorktreePool(clone).get(base, branch, task.id).path;
}

/** The questions bare `yan` asks. The real ones are Clack's; a test answers them itself. */
export interface EntryPrompts {
  chooseEntry(tasks: readonly TaskChoice[], vault: string): Promise<string>;
  askTitle(): Promise<string>;
  confirmTree(repo: string, why?: string): Promise<boolean>;
}

/** Starting the agent; returns its exit status. */
type StartAgent = (cli: string, argv: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => number;

export interface EntryDeps {
  readonly prompts?: EntryPrompts;
  readonly start?: StartAgent;
  /** Where `yan` was typed; the process's own directory by default. */
  readonly cwd?: string;
}

const startAgent: StartAgent = (cli, argv, options) => {
  const run = spawnSync(cli, [...argv], { stdio: 'inherit', cwd: options.cwd, env: options.env, windowsHide: true });
  if (run.error !== undefined) throw new YanError('yan_launch', `could not start ${cli}: ${run.error.message}`);
  return run.status ?? 1;
};

/** Start a task: its title, and a tree when `user` wants one of the repository they are in. */
async function newTask(cwd: string, prompts: EntryPrompts): Promise<{ task: Task; workdir: string }> {
  const title = await prompts.askTitle();
  const clone = mainClone(cwd);
  const url = clone === undefined ? undefined : remoteUrl(clone);

  if (clone === undefined || url === undefined || !(await prompts.confirmTree(repoKey(url)))) {
    return { task: Task.create(title), workdir: cwd };
  }
  const task = Task.create(title, url);
  return { task, workdir: leaseTree(task, clone) };
}

/**
 * Where an existing task's agent starts: its tree on this machine, a new one
 * when the task has a repository and `user` is in a clone of it, and here
 * otherwise.
 */
async function existingWorkdir(task: Task, cwd: string, prompts: EntryPrompts): Promise<string> {
  const lease = leaseHeldBy(task.id);
  if (lease !== undefined) return lease.path;

  const repo = task.read().repo;
  if (repo === undefined) return cwd;
  const clone = mainClone(cwd);
  const here = clone === undefined ? undefined : remoteUrl(clone);
  if (clone === undefined || here === undefined || repoKey(here) !== repoKey(repo)) {
    out(`${task.id} has no tree on this machine - run yan in a clone of ${repoKey(repo)} to open one`);
    return cwd;
  }
  return (await prompts.confirmTree(repoKey(repo), `${task.id} has no tree on this machine.`)) ? leaseTree(task, clone) : cwd;
}

/**
 * The whole of bare `yan`, at a terminal. Returns the agent's exit status.
 *
 * @param extra arguments after `--`, passed to the harness as they are.
 */
export async function enter(options: { cli?: string; extra: readonly string[] }, deps: EntryDeps = {}): Promise<number> {
  const vault = vaultDir();
  const harness = harnessConfig(options.cli);
  const cwd = normalizePath(deps.cwd ?? process.cwd());
  const prompts = deps.prompts ?? (await import('../../ui/prompts.js'));

  const chosen = await prompts.chooseEntry(openTasks(), readVaultJson(vault).name);
  const { task, workdir } = chosen === CREATE_NEW
    ? await newTask(cwd, prompts)
    : { task: new Task(chosen), workdir: await existingWorkdir(new Task(chosen), cwd, prompts) };

  out(`${task.id}  ${task.titleOrEmpty()}`);
  if (workdir !== cwd) out(`tree  ${tildePath(workdir)}`);
  out(`${cliKind(harness.cli)} starting`);

  const argv = [...launchArgs(harness.cli, { ...harness, workdir, prompt: OPENING_PROMPT }), ...options.extra];
  // The vault is explicit, so `yan vault use` elsewhere cannot move a running agent.
  return (deps.start ?? startAgent)(harness.cli, argv, { cwd: workdir, env: { ...process.env, YAN_TASK: task.id, YAN_VAULT: vault } });
}
