import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { out } from './action.js';
import { workspacePackages } from './packages.js';
import { openTasks } from './task-id.js';
import { repoKey } from '../../util/repo-key.js';
import { CREATE_NEW, type RepoChoice, type TaskChoice } from '../../ui/prompts.js';

export { CREATE_NEW };
import { tildePath } from './style.js';
import { cliKind, HARNESS_KINDS, isKnownCli, launchArgs } from '../../externals/harness/index.js';
import { WorktreePool, leasesHeldBy } from '../../externals/worktree/index.js';
import { cloneFor, register, registry, repoWithUrl } from '../../records/repos/index.js';
import { Task, type TaskRepo } from '../../records/task/index.js';
import { YanError } from '../../util/error.js';
import { defaultBranch, fetch, git, gitOk, remoteUrl } from '../../util/git.js';
import { asString } from '../../util/narrow.js';
import { isDirectory, normalizePath, samePath } from '../../util/paths.js';
import { readVaultConfig, readVaultJson, vaultConfigPath, vaultDir } from '../../util/vault.js';

/**
 * Bare `yan`: pick a task or start one, then start the agent on it in this
 * terminal: in the task's first tree when it has trees, with the others
 * added beside it.
 *
 * The agent is told as little as will let it find the rest: how the work is
 * done and which note keeps each step of it, the two commands that read
 * them, and which trees are which and what in them the task is about. Which task it is travels in
 * `$YAN_TASK`, which every command reads, so the agent never needs the id.
 */

/** What the agent is told before `user` says anything. */
export const OPENING_PROMPT = [
  'Notes from earlier sessions on this work are kept by a CLI.',
  'We work in three steps, each with its note: define the problem (problem.md: the background, and what the problem is), ' +
    'find the solution (the deliverables: how things must be once it is solved), ' +
    'carry it out (the log: the decisions that steered it). Problem and solution are worked out with the user, not assumed.',
  'Resources the work refers to (Jira tickets, docs, MR links and the like) are kept under a name with `yan resource`, for later sessions to find.',
  '`yan peek` shows the problem, the deliverables and the resources; `yan log` the decisions. `yan --help` for the rest.',
].join('\n');

/** One of the task's trees on this machine, as the agent is told about it. */
export interface Tree {
  /** The repository's registered name, or the last part of its URL. */
  readonly name: string;
  readonly path: string;
  readonly scope: readonly string[];
}

const quoted = (paths: readonly string[]): string => paths.map((p) => `\`${p}\``).join(', ');

/**
 * The opening prompt. One tree with a scope adds a line naming it; several
 * add a line per tree, since only the first is where the agent starts.
 */
export function openingPrompt(trees: readonly Tree[] = []): string {
  if (trees.length > 1) {
    const lines = trees.map((t) => `- ${t.name}: ${t.path}${t.scope.length === 0 ? '' : `, about ${quoted(t.scope)}`}`);
    return [OPENING_PROMPT, `This task works in ${trees.length} repositories, one worktree each:`, ...lines].join('\n');
  }
  const scope = trees[0]?.scope ?? [];
  if (scope.length === 0) return OPENING_PROMPT;
  return `${OPENING_PROMPT}\nThis task is about these parts of the repository: ${quoted(scope)}.`;
}

/** What a repository is called on screen: its registered name, or the last part of its URL. */
function repoName(url: string): string {
  return repoWithUrl(url)?.name ?? repoKey(url).split('/').pop() ?? url;
}

/**
 * The harness `config.json` names, or claude with its own defaults.
 * Approvals are skipped unless `skipPermissions` is `false`.
 */
interface HarnessConfig {
  readonly cli: string;
  readonly model: string;
  readonly effort: string;
  readonly skipPermissions: boolean;
}

function harnessConfig(override: string | undefined): HarnessConfig {
  const raw = readVaultConfig() ?? {};
  const configured = {
    cli: asString(raw.cli).trim() || 'claude',
    model: asString(raw.model).trim(),
    effort: asString(raw.effort).trim(),
    skipPermissions: raw.skipPermissions !== false,
  };
  // A model chosen for the configured CLI means nothing to another one.
  const chosen = override === undefined || override === '' || override === configured.cli
    ? configured
    : { cli: override, model: '', effort: '', skipPermissions: configured.skipPermissions };
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
  chooseRepos(repos: readonly RepoChoice[]): Promise<string[]>;
  confirmTree(repo: string, why?: string): Promise<boolean>;
  chooseScope(repo: string, packages: readonly string[]): Promise<string[]>;
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

/** A repository a new task can be given: registered and cloned here, or the clone `yan` was typed in. */
interface Candidate {
  readonly name: string;
  readonly url: string;
  readonly clone: string;
  readonly registered: boolean;
}

/**
 * Every registered repository cloned on this machine, and the clone `yan` was
 * typed in when nothing registered it yet; picking that one registers it.
 */
function candidates(cwd: string): Candidate[] {
  const found: Candidate[] = registry()
    .filter((r) => r.clone !== undefined && isDirectory(r.clone))
    .map((r) => ({ name: r.name, url: r.url, clone: r.clone as string, registered: true }));
  const here = mainClone(cwd);
  const url = here === undefined ? undefined : remoteUrl(here);
  if (here !== undefined && url !== undefined && repoWithUrl(url) === undefined) {
    found.push({ name: repoKey(url).split('/').pop() ?? 'repo', url, clone: here, registered: false });
  }
  return found;
}

/**
 * Start a task: its title, the repositories it works in, picked from the
 * registry wherever `yan` was typed, and for each one that has several
 * packages, the ones it is about. Asked once; every later start reads them
 * from task.json. Each repository gets a tree.
 */
async function newTask(cwd: string, prompts: EntryPrompts): Promise<{ task: Task; trees: Tree[] }> {
  const title = await prompts.askTitle();
  const offered = candidates(cwd);
  if (offered.length === 0) {
    out("no repository is registered and cloned here, so the task has no tree - 'yan repo add' registers one");
    return { task: Task.create(title), trees: [] };
  }

  // The clone `yan` was typed in comes first, so it is where the agent starts when picked.
  const here = mainClone(cwd);
  const isHere = (c: Candidate): boolean => here !== undefined && samePath(here, c.clone);
  offered.sort((a, b) => Number(isHere(b)) - Number(isHere(a)));
  const names = await prompts.chooseRepos(offered.map((c) => ({
    name: c.name,
    hint: c.registered ? tildePath(c.clone) : `${tildePath(c.clone)} - not registered yet, picking it registers it`,
    here: isHere(c),
  })));
  const picked = offered.filter((c) => names.includes(c.name));

  const repos: Array<TaskRepo & { candidate: Candidate }> = [];
  for (const c of picked) {
    if (!c.registered) register(c.name, c.url, c.clone);
    const packages = workspacePackages(c.clone);
    const scope = packages.length === 0 ? [] : await prompts.chooseScope(c.name, packages);
    repos.push({ url: c.url, scope, candidate: c });
  }
  const task = Task.create(title, repos.map(({ url, scope }) => ({ url, ...(scope === undefined ? {} : { scope }) })));
  const trees = repos.map((r) => ({ name: r.candidate.name, path: leaseTree(task, r.candidate.clone), scope: r.scope ?? [] }));
  return { task, trees };
}

/**
 * An existing task's trees on this machine, in the order task.json lists its
 * repositories. A repository with no tree here gets one, when `user` agrees,
 * from its linked clone or from the clone `yan` was typed in; one with no
 * clone here is named and skipped.
 */
async function existingTrees(task: Task, cwd: string, prompts: EntryPrompts): Promise<Tree[]> {
  const held = leasesHeldBy(task.id).map((l) => ({ path: l.path, key: repoKey(remoteUrl(l.path) ?? '') }));
  const here = mainClone(cwd);
  const hereUrl = here === undefined ? undefined : remoteUrl(here);

  const slots: Array<{ repo: TaskRepo; path?: string; clone?: string }> = task.read().repos.map((repo) => {
    const tree = held.find((h) => h.key === repoKey(repo.url));
    if (tree !== undefined) return { repo, path: tree.path };
    const clone = cloneFor(repo.url) ?? (hereUrl !== undefined && repoKey(hereUrl) === repoKey(repo.url) ? here : undefined);
    return clone === undefined ? { repo } : { repo, clone };
  });

  for (const s of slots) {
    if (s.path === undefined && s.clone === undefined) {
      out(`${repoName(s.repo.url)} has no clone on this machine, so no tree - 'yan repo add' where it is cloned`);
    }
  }
  const openable = slots.filter((s) => s.path === undefined && s.clone !== undefined);
  if (openable.length > 0) {
    const names = openable.map((s) => repoName(s.repo.url)).join(', ');
    if (await prompts.confirmTree(names, `${task.id} has no tree of ${names} on this machine.`)) {
      for (const s of openable) s.path = leaseTree(task, s.clone as string);
    }
  }

  const trees: Tree[] = slots
    .filter((s) => s.path !== undefined)
    .map((s) => ({ name: repoName(s.repo.url), path: s.path as string, scope: s.repo.scope ?? [] }));
  // A tree of a repository task.json no longer lists is still the task's.
  for (const h of held) {
    if (!trees.some((t) => t.path === h.path)) trees.push({ name: h.key.split('/').pop() ?? h.key, path: h.path, scope: [] });
  }
  return trees;
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
  const { task, trees } = chosen === CREATE_NEW
    ? await newTask(cwd, prompts)
    : { task: new Task(chosen), trees: await existingTrees(new Task(chosen), cwd, prompts) };

  out(`${task.id}  ${task.read().title}`);
  for (const t of trees) out(`tree  ${tildePath(t.path)}${t.scope.length === 0 ? '' : `  ${t.scope.join(', ')}`}`);
  out(`${cliKind(harness.cli)} starting`);

  const workdir = trees[0]?.path ?? cwd;
  const addDirs = trees.slice(1).map((t) => t.path);
  const argv = [...launchArgs(harness.cli, { ...harness, workdir, addDirs, prompt: openingPrompt(trees) }), ...options.extra];
  // The vault is explicit, so `yan vault use` elsewhere cannot move a running agent.
  return (deps.start ?? startAgent)(harness.cli, argv, { cwd: workdir, env: { ...process.env, YAN_TASK: task.id, YAN_VAULT: vault } });
}
